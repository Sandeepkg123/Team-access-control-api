const mongoose = require("mongoose");
const dns = require("dns");

dns.setServers(["8.8.8.8", "8.8.4.4"]);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1); // crash the app on purpose — don't run a server with no DB
  }
};

module.exports = connectDB;