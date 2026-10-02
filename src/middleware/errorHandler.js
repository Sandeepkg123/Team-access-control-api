/**
 * Single place where errors become HTTP responses.
 *
 * Controllers now call next(err) instead of catching and formatting their own
 * responses, so this middleware is actually reached. That matters for security:
 * the previous per-controller `catch` blocks returned err.message verbatim, so
 * raw MongoDB errors (duplicate key text, enum failures, CastError internals)
 * reached clients even in production and this file's redaction never ran.
 */

// Maps known Mongoose/Mongo failures onto safe 4xx responses. Anything not
// listed here is treated as a genuine 500 and redacted in production.
function classify(err) {
  // Duplicate key — e.g. two users with the same email, or the unique
  // TeamMember {userId, teamId} index.
  if (err.code === 11000 || err.code === 11001) {
    return { status: 409, message: "That record already exists" };
  }

  // Schema validation failure (missing required field, value outside enum).
  if (err.name === "ValidationError") {
    return { status: 400, message: "Invalid request data" };
  }

  // Malformed ObjectId. Body params used to reach here as a 500 because only
  // URL params passed through validateObjectId.
  if (err.name === "CastError") {
    return { status: 400, message: "Invalid identifier" };
  }

  return null;
}

// Express identifies error middleware by arity — all four params are required,
// so `next` stays declared even though it is unused here.
const errorHandler = (err, req, res, next) => {
  const known = classify(err);

  if (!known) {
    // Genuine server fault: always log the full stack for the developer.
    console.error(err.stack || err);
  }

  const status = err.statusCode || known?.status || 500;
  const message = known?.message || err.message;

  res.status(status).json({
    error: process.env.NODE_ENV === "production" ? "Something went wrong" : message,
  });
};

module.exports = errorHandler;