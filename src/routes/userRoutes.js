const express = require("express");
const router = express.Router();
const { getMe, updateProfile } = require("../controllers/userController");
const authenticate = require("../middleware/authenticate");
const validate = require("../middleware/validate");
const { updateProfileValidator } = require("../validators/userValidators");

router.use(authenticate);

router.get("/me", getMe);
router.patch("/me", updateProfileValidator, validate, updateProfile);

module.exports = router;
