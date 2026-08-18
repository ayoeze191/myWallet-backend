const crypto = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const { creditWallet, debitWallet, WalletError } = require('./ledger');
const { reserveTransaction, markTransactionStatus } = require('./idempotency');

/**
 * How far apart two consecutive rounds sit. Kept as Postgres intervals so
 * month arithmetic clamps correctly — Jan 31 + 1 month is Feb 28, not Mar 3.
 */
const FREQUENCY_INTERVAL = {
  daily: '1 day',
  weekly: '7 days',
  monthly: '1 month',
};

class AjoError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function newInviteCode() {
  // ~13 URL-safe chars. Long enough that codes can't be guessed, short
  // enough to paste into WhatsApp without wrapping.
  return crypto.randomBytes(10).toString('base64url');
}

// ---------------------------------------------------------------------------
// Creating and joining
// ---------------------------------------------------------------------------

/**
 * Start a new Ajo. The creator becomes member #1 and holds payout slot 1
 * by default — they can reshuffle everyone's slots later, before it starts.
 *
 * The group gets its OWN wallet (kind='escrow') to hold the pot. It is a
 * normal wallet row, so every naira that passes through a contribution shows
 * up in the same append-only ledger as everything else.
 */
async function createContribution({
  creatorId,
  name,
  description,
  contributionAmount,
  frequency,
  memberLimit,
  startDate,
}) {
  if (!FREQUENCY_INTERVAL[frequency]) {
    throw new AjoError('INVALID_FREQUENCY', 'frequency must be daily, weekly or monthly', 400);
  }
  if (!(Number(contributionAmount) > 0)) {
    throw new AjoError('INVALID_AMOUNT', 'contributionAmount must be positive', 400);
  }
  if (!Number.isInteger(memberLimit) || memberLimit < 2 || memberLimit > 50) {
    throw new AjoError('INVALID_MEMBER_LIMIT', 'memberLimit must be between 2 and 50', 400);
  }

  const creatorWallet = await getPersonalWallet(creatorId);

  return withTransaction(async (client) => {
    const { rows: dateCheck } = await client.query(
      'SELECT ($1::date < CURRENT_DATE) AS in_past',
      [startDate]
    );
    if (dateCheck[0].in_past) {
      throw new AjoError('START_DATE_IN_PAST', 'startDate cannot be in the past', 400);
    }

    const escrow = await client.query(
      `INSERT INTO wallets (user_id, owner_name, currency, kind)
       VALUES (NULL, $1, $2, 'escrow') RETURNING *`,
      [`${name} (pot)`, creatorWallet.currency]
    );

    const contribution = await client.query(
      `INSERT INTO contributions
         (creator_id, escrow_wallet_id, name, description, currency,
          contribution_amount, frequency, member_limit, start_date, invite_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        creatorId,
        escrow.rows[0].id,
        name,
        description || null,
        creatorWallet.currency,
        contributionAmount,
        frequency,
        memberLimit,
        startDate,
        newInviteCode(),
      ]
    );

    await client.query(
      `INSERT INTO contribution_members (contribution_id, user_id, wallet_id, payout_slot)
       VALUES ($1, $2, $3, 1)`,
      [contribution.rows[0].id, creatorId, creatorWallet.id]
    );

    return contribution.rows[0];
  });
}

/**
 * Join an Ajo using the code from a shared invite link.
 *
 * The row is locked FOR UPDATE first so two people clicking the link at the
 * same moment can't both take the last seat.
 */
async function joinByInviteCode({ inviteCode, userId }) {
  const wallet = await getPersonalWallet(userId);

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM contributions WHERE invite_code = $1 FOR UPDATE',
      [inviteCode]
    );
    const contribution = rows[0];
    if (!contribution) {
      throw new AjoError('INVITE_NOT_FOUND', 'That invite link is not valid', 404);
    }
    if (contribution.status !== 'open') {
      throw new AjoError(
        'CONTRIBUTION_CLOSED',
        contribution.status === 'active'
          ? 'This contribution has already started — it is no longer accepting members'
          : `This contribution is ${contribution.status}`
      );
    }

    const already = await client.query(
      'SELECT id FROM contribution_members WHERE contribution_id = $1 AND user_id = $2',
      [contribution.id, userId]
    );
    if (already.rows.length > 0) {
      throw new AjoError('ALREADY_A_MEMBER', 'You have already joined this contribution', 409);
    }

    const { rows: counted } = await client.query(
      'SELECT count(*)::int AS total FROM contribution_members WHERE contribution_id = $1',
      [contribution.id]
    );
    if (counted[0].total >= contribution.member_limit) {
      throw new AjoError('CONTRIBUTION_FULL', 'This contribution is already full');
    }

    // No payout_slot yet — the creator arranges the order before it starts,
    // and anyone still unassigned falls back to join order at launch.
    await client.query(
      `INSERT INTO contribution_members (contribution_id, user_id, wallet_id)
       VALUES ($1, $2, $3)`,
      [contribution.id, userId, wallet.id]
    );

    return contribution;
  });
}

async function getPersonalWallet(userId) {
  const { rows } = await pool.query(
    "SELECT * FROM wallets WHERE user_id = $1 AND kind = 'user'",
    [userId]
  );
  if (!rows[0]) throw new AjoError('WALLET_NOT_FOUND', 'You do not have a wallet yet', 404);
  return rows[0];
}

/**
 * The creator decides who collects the pot first, second, third...
 * Only while the group is still open — once it starts, the schedule is fixed.
 *
 * `slots` is [{ memberId, slot }]. Slots are wiped before being rewritten so
 * that swapping two members never trips the (contribution_id, payout_slot)
 * unique constraint mid-update.
 */
async function assignPayoutSlots({ contributionId, creatorId, slots }) {
  return withTransaction(async (client) => {
    const contribution = await loadForUpdate(client, contributionId);
    if (contribution.creator_id !== creatorId) {
      throw new AjoError('NOT_THE_CREATOR', 'Only the creator can set the payout order', 403);
    }
    if (contribution.status !== 'open') {
      throw new AjoError('CONTRIBUTION_CLOSED', 'The payout order is locked once the contribution starts');
    }

    const { rows: members } = await client.query(
      'SELECT id FROM contribution_members WHERE contribution_id = $1',
      [contributionId]
    );
    const memberIds = new Set(members.map((m) => m.id));

    const seenSlots = new Set();
    for (const { memberId, slot } of slots) {
      if (!memberIds.has(memberId)) {
        throw new AjoError('NOT_A_MEMBER', `${memberId} is not a member of this contribution`, 400);
      }
      if (!Number.isInteger(slot) || slot < 1 || slot > members.length) {
        throw new AjoError('INVALID_SLOT', `Slot must be between 1 and ${members.length}`, 400);
      }
      if (seenSlots.has(slot)) {
        throw new AjoError('DUPLICATE_SLOT', `Two members cannot share slot ${slot}`, 400);
      }
      seenSlots.add(slot);
    }

    await client.query(
      'UPDATE contribution_members SET payout_slot = NULL WHERE contribution_id = $1',
      [contributionId]
    );
    for (const { memberId, slot } of slots) {
      await client.query('UPDATE contribution_members SET payout_slot = $1 WHERE id = $2', [
        slot,
        memberId,
      ]);
    }

    return listMembers(client, contributionId);
  });
}

async function loadForUpdate(client, contributionId) {
  const { rows } = await client.query('SELECT * FROM contributions WHERE id = $1 FOR UPDATE', [
    contributionId,
  ]);
  if (!rows[0]) throw new AjoError('CONTRIBUTION_NOT_FOUND', 'Contribution not found', 404);
  return rows[0];
}

async function cancelContribution({ contributionId, creatorId }) {
  return withTransaction(async (client) => {
    const contribution = await loadForUpdate(client, contributionId);
    if (contribution.creator_id !== creatorId) {
      throw new AjoError('NOT_THE_CREATOR', 'Only the creator can cancel this contribution', 403);
    }
    if (contribution.status !== 'open') {
      throw new AjoError(
        'ALREADY_STARTED',
        'A contribution that has already started cannot be cancelled — money is in play'
      );
    }
    const { rows } = await client.query(
      "UPDATE contributions SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [contributionId]
    );
    return rows[0];
  });
}

async function leaveContribution({ contributionId, userId }) {
  return withTransaction(async (client) => {
    const contribution = await loadForUpdate(client, contributionId);
    if (contribution.status !== 'open') {
      throw new AjoError('ALREADY_STARTED', 'You cannot leave a contribution once it has started');
    }
    if (contribution.creator_id === userId) {
      throw new AjoError(
        'CREATOR_CANNOT_LEAVE',
        'The creator cannot leave — cancel the contribution instead'
      );
    }
    const { rowCount } = await client.query(
      'DELETE FROM contribution_members WHERE contribution_id = $1 AND user_id = $2',
      [contributionId, userId]
    );
    if (rowCount === 0) throw new AjoError('NOT_A_MEMBER', 'You are not a member of this contribution', 404);
  });
}

// ---------------------------------------------------------------------------
// The rotation engine
// ---------------------------------------------------------------------------

/**
 * Freeze the membership and lay out the full payout schedule.
 *
 * Slots are renumbered to a clean 1..N here. The creator may have assigned
 * slot 6 back when they expected six members but only four turned up — the
 * ordering they chose is preserved, the gaps are just squeezed out.
 */
async function activate(client, contribution) {
  const { rows: members } = await client.query(
    `SELECT id FROM contribution_members
     WHERE contribution_id = $1
     ORDER BY COALESCE(payout_slot, 2147483647), joined_at, id`,
    [contribution.id]
  );

  if (members.length < 2) {
    // Nobody to rotate with. Stay open and try again next tick — the creator
    // can keep sharing the link, or cancel.
    return null;
  }

  await client.query('UPDATE contribution_members SET payout_slot = NULL WHERE contribution_id = $1', [
    contribution.id,
  ]);
  for (let i = 0; i < members.length; i++) {
    await client.query('UPDATE contribution_members SET payout_slot = $1 WHERE id = $2', [
      i + 1,
      members[i].id,
    ]);
  }

  const potPerRound = Number(contribution.contribution_amount) * members.length;
  const interval = FREQUENCY_INTERVAL[contribution.frequency];

  await client.query(
    `INSERT INTO contribution_rounds
       (contribution_id, round_number, recipient_member_id, due_date, expected_total)
     SELECT $1, m.payout_slot, m.id,
            $2::date + (m.payout_slot - 1) * $3::interval,
            $4
     FROM contribution_members m
     WHERE m.contribution_id = $1
     ON CONFLICT (contribution_id, round_number) DO NOTHING`,
    [contribution.id, contribution.start_date, interval, potPerRound]
  );

  // Every member owes into every round, the recipient included.
  await client.query(
    `INSERT INTO round_contributions (round_id, member_id, amount)
     SELECT r.id, m.id, $2
     FROM contribution_rounds r
     JOIN contribution_members m ON m.contribution_id = r.contribution_id
     WHERE r.contribution_id = $1
     ON CONFLICT (round_id, member_id) DO NOTHING`,
    [contribution.id, contribution.contribution_amount]
  );

  const { rows } = await client.query(
    `UPDATE contributions
     SET status = 'active', started_at = now(), total_rounds = $2
     WHERE id = $1 RETURNING *`,
    [contribution.id, members.length]
  );
  return rows[0];
}

/**
 * Pull every outstanding contribution for one round out of members' wallets
 * and into the pot. Returns true only once the round is fully collected AND
 * paid out.
 *
 * A member with an empty wallet is NOT an error — their row stays pending and
 * gets retried on the next tick. The pot only pays out when it is whole, so
 * one person being short delays the round rather than shorting the recipient.
 */
async function collectRound(client, contribution, round) {
  const { rows: outstanding } = await client.query(
    `SELECT rc.id, rc.amount, rc.attempts, rc.member_id, m.wallet_id, m.user_id
     FROM round_contributions rc
     JOIN contribution_members m ON m.id = rc.member_id
     WHERE rc.round_id = $1 AND rc.status = 'pending'
     ORDER BY m.payout_slot`,
    [round.id]
  );

  for (const due of outstanding) {
    // Deterministic key: retrying this member's payment for this round can
    // never produce a second debit, however many ticks run.
    const { transaction } = await reserveTransaction({
      client,
      idempotencyKey: `ajo:contribution:${due.id}`,
      type: 'contribution',
      metadata: {
        contributionId: contribution.id,
        roundId: round.id,
        roundNumber: round.round_number,
        memberId: due.member_id,
      },
    });

    try {
      await debitWallet({
        client,
        walletId: due.wallet_id,
        amount: due.amount,
        transactionId: transaction.id,
      });
      await creditWallet({
        client,
        walletId: contribution.escrow_wallet_id,
        amount: due.amount,
        transactionId: transaction.id,
      });
      await markTransactionStatus(transaction.id, 'success', client);
      await client.query(
        `UPDATE round_contributions
         SET status = 'paid', paid_at = now(), attempts = attempts + 1,
             transaction_id = $1, last_error = NULL
         WHERE id = $2`,
        [transaction.id, due.id]
      );
    } catch (err) {
      if (!(err instanceof WalletError)) throw err;

      // debitWallet checks the balance in JS and bails before issuing any
      // failing SQL, so the surrounding transaction is still healthy and the
      // members who DID pay stay paid.
      if (due.attempts === 0) {
        await client.query(
          'UPDATE contribution_members SET missed_rounds = missed_rounds + 1 WHERE id = $1',
          [due.member_id]
        );
      }
      await client.query(
        'UPDATE round_contributions SET attempts = attempts + 1, last_error = $1 WHERE id = $2',
        [err.code, due.id]
      );
    }
  }

  const { rows: tally } = await client.query(
    `SELECT count(*) FILTER (WHERE status = 'pending')::int AS still_pending
     FROM round_contributions WHERE round_id = $1`,
    [round.id]
  );

  if (tally[0].still_pending > 0) {
    await client.query(
      "UPDATE contribution_rounds SET status = 'collecting' WHERE id = $1 AND status = 'pending'",
      [round.id]
    );
    return false;
  }

  await payOutRound(client, contribution, round);
  return true;
}

/** Hand the whole pot to whoever holds this round's slot. */
async function payOutRound(client, contribution, round) {
  const { rows: recipients } = await client.query(
    'SELECT wallet_id, user_id FROM contribution_members WHERE id = $1',
    [round.recipient_member_id]
  );
  const recipient = recipients[0];

  const { transaction } = await reserveTransaction({
    client,
    idempotencyKey: `ajo:payout:${round.id}`,
    type: 'payout',
    metadata: {
      contributionId: contribution.id,
      roundId: round.id,
      roundNumber: round.round_number,
      recipientUserId: recipient.user_id,
    },
  });

  await debitWallet({
    client,
    walletId: contribution.escrow_wallet_id,
    amount: round.expected_total,
    transactionId: transaction.id,
  });
  await creditWallet({
    client,
    walletId: recipient.wallet_id,
    amount: round.expected_total,
    transactionId: transaction.id,
  });
  await markTransactionStatus(transaction.id, 'success', client);

  await client.query(
    `UPDATE contribution_rounds
     SET status = 'paid', collected_at = COALESCE(collected_at, now()), paid_at = now()
     WHERE id = $1`,
    [round.id]
  );
}

/**
 * Advance one contribution as far as it can go right now: start it if the
 * date has arrived, then collect and pay out every round that is due.
 *
 * SKIP LOCKED means a second tick that overlaps the first just moves on
 * instead of queueing up behind it and doing the work twice.
 */
async function processContribution(contributionId) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT *, (start_date <= CURRENT_DATE) AS has_started
       FROM contributions
       WHERE id = $1 AND status IN ('open', 'active')
       FOR UPDATE SKIP LOCKED`,
      [contributionId]
    );
    let contribution = rows[0];
    if (!contribution) return { processed: false, reason: 'busy-or-finished' };

    if (contribution.status === 'open') {
      if (!contribution.has_started) {
        return { processed: false, reason: 'not-yet-started' };
      }
      const activated = await activate(client, contribution);
      if (!activated) {
        return { processed: false, reason: 'waiting-for-members' };
      }
      contribution = activated;
    }

    const { rows: dueRounds } = await client.query(
      `SELECT * FROM contribution_rounds
       WHERE contribution_id = $1 AND status <> 'paid' AND due_date <= CURRENT_DATE
       ORDER BY round_number`,
      [contribution.id]
    );

    const roundsPaid = [];
    for (const round of dueRounds) {
      // Rounds are strictly sequential. If this one can't close, later rounds
      // wait — nobody collects out of turn because someone else was broke.
      const completed = await collectRound(client, contribution, round);
      if (!completed) break;
      roundsPaid.push(round.round_number);
    }

    const { rows: left } = await client.query(
      "SELECT count(*)::int AS remaining FROM contribution_rounds WHERE contribution_id = $1 AND status <> 'paid'",
      [contribution.id]
    );
    if (left[0].remaining === 0) {
      await client.query(
        "UPDATE contributions SET status = 'completed', completed_at = now() WHERE id = $1",
        [contribution.id]
      );
    }

    return { processed: true, roundsPaid, completed: left[0].remaining === 0 };
  });
}

/** One engine pass over every contribution that could possibly need work. */
async function runDueContributions() {
  const { rows } = await pool.query(
    `SELECT id FROM contributions
     WHERE (status = 'open' AND start_date <= CURRENT_DATE)
        OR status = 'active'
     ORDER BY created_at`
  );

  const results = [];
  for (const { id } of rows) {
    try {
      results.push({ id, ...(await processContribution(id)) });
    } catch (err) {
      console.error(`[ajo] failed to process contribution ${id}:`, err);
      results.push({ id, processed: false, reason: 'error', error: err.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function listMembers(db, contributionId) {
  return db
    .query(
      `SELECT m.id, m.user_id, m.payout_slot, m.missed_rounds, m.joined_at,
              u.name, u.email,
              (m.user_id = c.creator_id) AS is_creator
       FROM contribution_members m
       JOIN users u ON u.id = m.user_id
       JOIN contributions c ON c.id = m.contribution_id
       WHERE m.contribution_id = $1
       ORDER BY COALESCE(m.payout_slot, 2147483647), m.joined_at`,
      [contributionId]
    )
    .then((r) => r.rows);
}

async function listMyContributions(userId) {
  const { rows } = await pool.query(
    `SELECT c.*,
            (c.creator_id = $1) AS is_creator,
            (SELECT count(*)::int FROM contribution_members m WHERE m.contribution_id = c.id) AS member_count,
            (SELECT count(*)::int FROM contribution_rounds r
              WHERE r.contribution_id = c.id AND r.status = 'paid') AS rounds_paid,
            w.balance AS pot_balance
     FROM contributions c
     JOIN contribution_members me ON me.contribution_id = c.id AND me.user_id = $1
     JOIN wallets w ON w.id = c.escrow_wallet_id
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return rows;
}

/** Full view of one contribution. Members only — the invite preview is separate. */
async function getContributionDetail({ contributionId, userId }) {
  const { rows } = await pool.query(
    `SELECT c.*, w.balance AS pot_balance,
            (c.creator_id = $2) AS is_creator
     FROM contributions c
     JOIN wallets w ON w.id = c.escrow_wallet_id
     WHERE c.id = $1`,
    [contributionId, userId]
  );
  const contribution = rows[0];
  if (!contribution) throw new AjoError('CONTRIBUTION_NOT_FOUND', 'Contribution not found', 404);

  const members = await listMembers(pool, contributionId);
  const me = members.find((m) => m.user_id === userId);
  if (!me) {
    throw new AjoError('NOT_A_MEMBER', 'You are not a member of this contribution', 403);
  }

  const { rows: rounds } = await pool.query(
    `SELECT r.*, u.name AS recipient_name, m.user_id AS recipient_user_id,
            (SELECT count(*)::int FROM round_contributions rc
              WHERE rc.round_id = r.id AND rc.status = 'paid') AS paid_count,
            (SELECT count(*)::int FROM round_contributions rc WHERE rc.round_id = r.id) AS member_count,
            (SELECT rc.status FROM round_contributions rc
              WHERE rc.round_id = r.id AND rc.member_id = $2) AS my_status
     FROM contribution_rounds r
     JOIN contribution_members m ON m.id = r.recipient_member_id
     JOIN users u ON u.id = m.user_id
     WHERE r.contribution_id = $1
     ORDER BY r.round_number`,
    [contributionId, me.id]
  );

  return { contribution, members, rounds, me };
}

/**
 * What someone sees when they open an invite link, before signing in.
 * Deliberately thin: enough to decide whether to join, no member emails,
 * no pot balance.
 */
async function getInvitePreview(inviteCode) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.description, c.currency, c.contribution_amount,
            c.frequency, c.member_limit, c.start_date, c.status, c.invite_code,
            u.name AS creator_name,
            (SELECT count(*)::int FROM contribution_members m WHERE m.contribution_id = c.id) AS member_count
     FROM contributions c
     JOIN users u ON u.id = c.creator_id
     WHERE c.invite_code = $1`,
    [inviteCode]
  );
  if (!rows[0]) throw new AjoError('INVITE_NOT_FOUND', 'That invite link is not valid', 404);

  const preview = rows[0];
  // What the pot is worth once the group fills up — that is the number
  // someone is deciding against, not today's partial count.
  preview.pot_when_full =
    Number(preview.contribution_amount) * Number(preview.member_limit);
  return preview;
}

module.exports = {
  createContribution,
  joinByInviteCode,
  assignPayoutSlots,
  cancelContribution,
  leaveContribution,
  processContribution,
  runDueContributions,
  listMyContributions,
  getContributionDetail,
  getInvitePreview,
  AjoError,
};
