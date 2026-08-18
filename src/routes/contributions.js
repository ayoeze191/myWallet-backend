const express = require('express');
const { requireAuth } = require('../middleware/requireAuth');
const { WalletError } = require('../services/ledger');
const ajo = require('../services/ajo');
const { AjoError } = require('../services/ajo');

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5173';

function inviteLink(code) {
  return `${APP_BASE_URL}/join/${code}`;
}

/**
 * Express 4 does not catch rejected promises from async handlers, so every
 * handler goes through here — a thrown AjoError becomes a clean JSON error
 * instead of a silent unhandled rejection.
 */
function route(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (err instanceof AjoError) {
        return res.status(err.status).json({ error: err.code, message: err.message });
      }
      if (err instanceof WalletError) {
        return res.status(422).json({ error: err.code, message: err.message });
      }
      next(err);
    });
  };
}

// ---------------------------------------------------------------------------
// Public — this is what an invite link opens. No token required, because the
// person clicking it may not have an account yet.
// ---------------------------------------------------------------------------
const publicContributionRoutes = express.Router();

publicContributionRoutes.get(
  '/invites/:code',
  route(async (req, res) => {
    const preview = await ajo.getInvitePreview(req.params.code);
    res.json({ ...preview, invite_link: inviteLink(preview.invite_code) });
  })
);

// ---------------------------------------------------------------------------
// Authenticated
// ---------------------------------------------------------------------------
const contributionRoutes = express.Router();
contributionRoutes.use(requireAuth);

/** Start an Ajo. Responds with the link to share. */
contributionRoutes.post(
  '/contributions',
  route(async (req, res) => {
    const { name, description, contributionAmount, frequency, memberLimit, startDate } = req.body;

    if (!name || !contributionAmount || !frequency || !memberLimit || !startDate) {
      return res.status(400).json({
        error:
          'name, contributionAmount, frequency, memberLimit and startDate are required',
      });
    }

    const contribution = await ajo.createContribution({
      creatorId: req.userId,
      name,
      description,
      contributionAmount,
      frequency,
      memberLimit: Number(memberLimit),
      startDate,
    });

    res.status(201).json({
      ...contribution,
      invite_link: inviteLink(contribution.invite_code),
    });
  })
);

/** Every Ajo I created or joined. */
contributionRoutes.get(
  '/contributions',
  route(async (req, res) => {
    const contributions = await ajo.listMyContributions(req.userId);
    res.json(
      contributions.map((c) => ({ ...c, invite_link: inviteLink(c.invite_code) }))
    );
  })
);

/** Accept an invite. */
contributionRoutes.post(
  '/invites/:code/join',
  route(async (req, res) => {
    const contribution = await ajo.joinByInviteCode({
      inviteCode: req.params.code,
      userId: req.userId,
    });
    res.status(201).json({ message: 'You have joined this contribution', contribution });
  })
);

contributionRoutes.get(
  '/contributions/:id',
  route(async (req, res) => {
    const detail = await ajo.getContributionDetail({
      contributionId: req.params.id,
      userId: req.userId,
    });
    res.json({
      ...detail,
      contribution: {
        ...detail.contribution,
        invite_link: inviteLink(detail.contribution.invite_code),
      },
    });
  })
);

/** Creator rearranges who collects the pot in which round. */
contributionRoutes.put(
  '/contributions/:id/payout-order',
  route(async (req, res) => {
    const { slots } = req.body;
    if (!Array.isArray(slots) || slots.length === 0) {
      return res.status(400).json({ error: 'slots must be a non-empty array of { memberId, slot }' });
    }
    const members = await ajo.assignPayoutSlots({
      contributionId: req.params.id,
      creatorId: req.userId,
      slots: slots.map((s) => ({ memberId: s.memberId, slot: Number(s.slot) })),
    });
    res.json({ message: 'Payout order updated', members });
  })
);

contributionRoutes.post(
  '/contributions/:id/cancel',
  route(async (req, res) => {
    const contribution = await ajo.cancelContribution({
      contributionId: req.params.id,
      creatorId: req.userId,
    });
    res.json({ message: 'Contribution cancelled', contribution });
  })
);

contributionRoutes.post(
  '/contributions/:id/leave',
  route(async (req, res) => {
    await ajo.leaveContribution({ contributionId: req.params.id, userId: req.userId });
    res.json({ message: 'You have left this contribution' });
  })
);

/**
 * Nudge the engine for one group instead of waiting for the next scheduled
 * sweep. Members only — it just runs the same code the scheduler runs, so
 * the worst a member can do is make their own group catch up sooner.
 */
contributionRoutes.post(
  '/contributions/:id/run',
  route(async (req, res) => {
    // Throws NOT_A_MEMBER for outsiders.
    await ajo.getContributionDetail({ contributionId: req.params.id, userId: req.userId });
    const result = await ajo.processContribution(req.params.id);
    res.json(result);
  })
);

module.exports = { publicContributionRoutes, contributionRoutes };
