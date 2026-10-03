const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/authRoutes");
const teamRoutes = require("./routes/teamRoutes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Rate limiting and rate-limit logging key off req.ip. Behind a reverse proxy
// (Render, Railway, Vercel, nginx) every request otherwise arrives from the
// proxy's own IP, so one user exhausting the limit locks out everyone.
//
// Opt-in via TRUST_PROXY because trusting X-Forwarded-For unconditionally lets
// any client spoof its IP and bypass the limiters entirely. Set it to the
// number of proxy hops in front of the app, or "true" for a single proxy.
if (process.env.TRUST_PROXY) {
  const hops = process.env.TRUST_PROXY;
  app.set("trust proxy", hops === "true" ? 1 : Number(hops) || 1);
  console.log(`trust proxy enabled (${hops})`);
}

app.use(express.json());        // parses JSON body of incoming requests
app.use(cookieParser());        // parses cookies (for refresh token later)
app.use(cors({
  origin: [
    "https://team-access-control-frontend.vercel.app",
    "http://localhost:5173"
  ],
  credentials: true                 // allows cookies to be sent cross-origin
}));

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Backend is running correctly",
    timestamp: new Date().toISOString()
  });
});

app.use("/auth", authRoutes);
app.use("/teams", teamRoutes);
app.use(errorHandler);



module.exports = app;