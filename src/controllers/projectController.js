const Project = require("../models/Project");

// CREATE PROJECT
const createProject = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { title, description } = req.body;

    const project = await Project.create({
      title,
      description,
      teamId,
      createdBy: req.user.id,
    });

    res.status(201).json({ message: "Project created", project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// LIST PROJECTS FOR A TEAM
const listProjects = async (req, res) => {
  try {
    const { teamId } = req.params;
    const projects = await Project.find({ teamId }).populate("createdBy", "name email");
    res.status(200).json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// UPDATE PROJECT
const updateProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const { title, description } = req.body;

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const isOwnerOrAdmin = ["owner", "admin"].includes(req.membership.role);
    const isCreator = project.createdBy.toString() === req.user.id;

    if (!isOwnerOrAdmin && !isCreator) {
      return res.status(403).json({ error: "You can only edit your own projects" });
    }

    if (title) project.title = title;
    if (description) project.description = description;
    await project.save();

    res.status(200).json({ message: "Project updated", project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE PROJECT
const deleteProject = async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    await Project.findByIdAndDelete(projectId);
    res.status(200).json({ message: "Project deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

module.exports = { createProject, listProjects, updateProject, deleteProject }; 