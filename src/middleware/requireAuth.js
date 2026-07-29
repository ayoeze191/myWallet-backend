const { verifyToken } = require("../services/auth");

/**
 * Requires a valid "Authorization: Bearer <token>" header.
 * On success, sets req.userId for downstream routes to use.
 * This is what gives us authorization, not just authentication —
 * every wallet route below trusts req.userId, never a value from the body.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  // console.log("Bearer", token);
  if (scheme !== "Bearer" || !token) {
    return res
      .status(401)
      .json({ error: "Missing or malformed Authorization header" });
  }
  try {
    const payload = verifyToken(token);
    req.userId = payload.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
module.exports = { requireAuth };
