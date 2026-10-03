require("dotenv").config();
const { validateEnv } = require("./src/config/env");
const app = require("./src/app");
const connectDB = require("./src/config/db");

// Before anything connects or listens, so a bad .env fails immediately with a
// clear message instead of surfacing later as a 500 on the first request.
validateEnv();

const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
});