const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/authRoutes");
const teamRoutes = require("./routes/teamRoutes");
const errorHandler = require("./middleware/errorHandler");

const app = express();

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