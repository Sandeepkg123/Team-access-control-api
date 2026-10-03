const mongoose = require("mongoose");
const dns = require("dns");

// Atlas SRV lookups fail on some Windows resolvers, so pin public DNS before
// mongoose does its own SRV resolution.
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      // Atlas resolves shard hostnames dynamically. If one of those DNS lookups
      // fails intermittently (ENOTFOUND), a short selection timeout surfaces it
      // straight to the request as a 500. A longer window lets the driver retry
      // the lookup instead.
      serverSelectionTimeoutMS: 30000,
      // Retry transient network blips and failovers rather than erroring.
      retryWrites: true,
      retryReads: true,
      // Atlas free/shared tiers cap connections aggressively; a small pool
      // avoids exhausting the cluster's limit.
      maxPoolSize: 10,
    });
    console.log("✅ MongoDB connected");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    process.exit(1); // crash the app on purpose — don't run a server with no DB
  }
};

module.exports = connectDB;