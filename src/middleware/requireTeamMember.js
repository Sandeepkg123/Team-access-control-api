const TeamMember = require("../models/TeamMember");

const requireTeamMember = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    const userId = req.user.id;

    const membership = await TeamMember.findOne({ teamId, userId });

    if (!membership) {
      return res.status(403).json({ error: "You are not a member of this team" });
    }

    req.membership = membership; // attach for next middleware/controller to use
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = requireTeamMember;