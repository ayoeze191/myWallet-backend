// Express 4 ignores rejected promises from async handlers, and on Node 15+ an
// unhandled rejection kills the process. Forward them to the error handler.
function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { asyncRoute };
