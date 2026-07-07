const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const authRoutes = require("./routes/authRoutes");
const teamRoutes = require("./routes/teamRoutes");

const app = express();

app.use(express.json());        // parses JSON body of incoming requests
app.use(cookieParser());        // parses cookies (for refresh token later)
app.use(cors({
  origin: "http://localhost:3000", // your future frontend
  credentials: true                 // allows cookies to be sent cross-origin
}));

app.use("/auth", authRoutes);
app.use("/teams", teamRoutes);



module.exports = app;