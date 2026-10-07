const Project = require("../models/Project");
const ProjectMember = require("../models/ProjectMember");
const TeamMember = require("../models/TeamMember");

// CREATE PROJECT
const createProject = async (req, res, next) => {
  try {
    const { teamId } = req.params;
    // No validator runs ahead of this route, so a request with no body reaches
    // here with req.body undefined (Express 5) and threw a TypeError -> 500.
    const { title, description } = req.body || {};

    const project = await Project.create({
      title,
      description,
      teamId,
      createdBy: req.user.id,
    });

    res.status(201).json({ message: "Project created", project });
  } catch (err) {
    next(err);
  }
};

// LIST PROJECTS FOR A TEAM
const listProjects = async (req, res, next) => {
  try {
    const { teamId } = req.params;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const [projects, total] = await Promise.all([
      Project.find({ teamId }).populate("createdBy", "name email").skip(skip).limit(limit),
      Project.countDocuments({ teamId }),
    ]);

    res.status(200).json({ projects, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    next(err);
  }
};

// Resolves the effective permission for the caller on one project.
//
// Overrides are strictly ADDITIVE: a row in ProjectMember can only ever grant
// access that the team role would not have given on its own. That is deliberate.
// The alternative — letting a "viewer" row demote an owner or a project's own
// creator — makes it possible to lock yourself out of your own work by granting
// the wrong row, and gives the owner/admin check a second code path to get
// wrong. Grant-only means the worst a bad override can do is grant access too
// widely, which is visible and fixable, rather than silently deleting a
// founder's ability to edit.
async function resolveProjectAccess(project, req) {
  const teamRole = req.membership.role;
  const isCreator = project.createdBy.toString() === req.user.id;

  const override = await ProjectMember.findOne({
    projectId: project._id,
    userId: req.user.id,
  });

  return {
    teamRole,
    isCreator,
    projectRole: override?.role ?? null,
    isTeamManager: ["owner", "admin"].includes(teamRole),
    canEdit:
      ["owner", "admin"].includes(teamRole) ||
      override?.role === "editor" ||
      (teamRole === "member" && isCreator),
    // Managing access is broader than editing: it lets you widen who else can
    // edit, so a viewer is excluded here even though a viewer is a legitimate
    // grant target below. An editor can delegate, which is what makes "editor"
    // mean full control of the project rather than just a content role — the
    // team owner granted that by handing out the editor role in the first place.
    canManageOverrides:
      ["owner", "admin"].includes(teamRole) || override?.role === "editor",
  };
}

// UPDATE PROJECT
const updateProject = async (req, res, next) => {
  try {
    const { teamId, projectId } = req.params;
    // Same undefined-body guard as createProject. A bodyless PATCH is a valid
    // no-op, not a crash.
    const { title, description } = req.body || {};

    // Scope the lookup by BOTH ids: a projectId from another team simply won't
    // match. Returns 404 rather than 403 so we don't confirm the id exists elsewhere.
    const project = await Project.findOne({ _id: projectId, teamId });
    if (!project) return res.status(404).json({ error: "Project not found" });

    const access = await resolveProjectAccess(project, req);

    if (!access.canEdit) {
      return res.status(403).json({
        error: access.projectRole
          ? "You have read-only access to this project"
          : "You can only edit your own projects",
      });
    }

    // Compare against undefined rather than truthiness: an empty string is a valid
    // value here and must CLEAR the field. `if (description)` would silently
    // ignore "", leaving stale text the user thought they had removed. title is
    // required by the schema, so a blank title fails validation below.
    if (title !== undefined) project.title = title;
    if (description !== undefined) project.description = description;
    await project.save();

    res.status(200).json({ message: "Project updated", project });
  } catch (err) {
    next(err);
  }
};

// DELETE PROJECT
const deleteProject = async (req, res, next) => {
  try {
    const { teamId, projectId } = req.params;
    const project = await Project.findOne({ _id: projectId, teamId });
    if (!project) return res.status(404).json({ error: "Project not found" });

    // Cascade the overrides, or they become unreachable rows pointing at a
    // project that no longer exists — the same orphaning bug the team cascade
    // fixes. Wrapped with the delete so the project never survives without its
    // own permission rows being cleaned up.
    await ProjectMember.deleteMany({ projectId: project._id });
    await Project.findByIdAndDelete(project._id);

    res.status(200).json({ message: "Project deleted" });
  } catch (err) {
    next(err);
  }
};

// ADD / UPDATE PROJECT MEMBER (override)
const addProjectMember = async (req, res, next) => {
  try {
    const { teamId, projectId } = req.params;
    const { userId, role } = req.body || {};

    const project = await Project.findOne({ _id: projectId, teamId });
    if (!project) return res.status(404).json({ error: "Project not found" });

    const access = await resolveProjectAccess(project, req);
    if (!access.canManageOverrides) {
      return res.status(403).json({ error: "You cannot manage access to this project" });
    }

    // The target must already belong to the team. Granting a project override to
    // a non-member would hand out access to someone who cannot even read the
    // team, and the row would survive their later removal from it.
    const targetMembership = await TeamMember.findOne({ teamId, userId });
    if (!targetMembership) {
      return res.status(400).json({ error: "That user is not a member of this team" });
    }

    // Upsert rather than insert: re-granting with a different role should change
    // the role, not collide with the unique {userId, projectId} index as a 409.
    // returnDocument:"after" is the Mongoose 9 spelling of the old `new: true` —
    // without it the pre-update document is returned and the response would show
    // the OLD role, making a successful upgrade look like it silently failed.
    const membership = await ProjectMember.findOneAndUpdate(
      { projectId: project._id, userId },
      { role },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
    ).populate("userId", "name email");

    res.status(201).json({ message: "Project access granted", membership });
  } catch (err) {
    next(err);
  }
};

// LIST PROJECT MEMBERS (overrides)
const listProjectMembers = async (req, res, next) => {
  try {
    const { teamId, projectId } = req.params;

    // Same both-id scoping as every other project route, so a projectId from
    // another team 404s rather than leaking its override list.
    const project = await Project.findOne({ _id: projectId, teamId });
    if (!project) return res.status(404).json({ error: "Project not found" });

    const members = await ProjectMember.find({ projectId: project._id })
      .populate("userId", "name email")
      .sort({ createdAt: -1 });

    res.status(200).json({ members });
  } catch (err) {
    next(err);
  }
};

// REMOVE PROJECT MEMBER (override)
const removeProjectMember = async (req, res, next) => {
  try {
    const { teamId, projectId, userId } = req.params;

    const project = await Project.findOne({ _id: projectId, teamId });
    if (!project) return res.status(404).json({ error: "Project not found" });

    const access = await resolveProjectAccess(project, req);
    if (!access.canManageOverrides) {
      return res.status(403).json({ error: "You cannot manage access to this project" });
    }

    const membership = await ProjectMember.findOne({ projectId: project._id, userId });
    if (!membership) return res.status(404).json({ error: "Project access not found" });

    await ProjectMember.findByIdAndDelete(membership._id);

    res.status(200).json({ message: "Project access removed" });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createProject,
  listProjects,
  updateProject,
  deleteProject,
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
};