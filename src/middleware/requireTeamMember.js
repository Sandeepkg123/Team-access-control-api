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
    // Must forward, not answer here. Swallowing it and returning
    // `err.message` leaked raw Mongoose internals to the client (e.g.
    // "Cast to ObjectId failed for value \"nope\" ... for model \"TeamMember\"")
    // and bypassed the redaction in the central errorHandler. A CastError on a
    // bad teamId belongs there too, where it becomes a clean 400.
    next(err);
  }
};

module.exports = requireTeamMember;