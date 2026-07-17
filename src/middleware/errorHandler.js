const errorHandler = (err, req, res, next) => {
  console.error(err.stack); // log full details for YOU (the dev)

  res.status(err.statusCode || 500).json({
    error: process.env.NODE_ENV === "production" ? "Something went wrong" : err.message,
  });
};

module.exports = errorHandler;