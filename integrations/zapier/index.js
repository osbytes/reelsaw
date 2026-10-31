"use strict";

const authentication = require("./authentication");
const { befores, afters } = require("./lib/middleware");
const projectDone = require("./triggers/project_done");
const clipDone = require("./triggers/clip_done");
const projectFailed = require("./triggers/project_failed");
const createProject = require("./creates/create_project");
const getShareLinks = require("./creates/get_share_links");
const findProject = require("./searches/find_project");

module.exports = {
  version: require("./package.json").version,
  platformVersion: require("zapier-platform-core").version,

  authentication,
  beforeRequest: [...befores],
  afterResponse: [...afters],

  triggers: {
    [projectDone.key]: projectDone,
    [clipDone.key]: clipDone,
    [projectFailed.key]: projectFailed,
  },
  searches: {
    [findProject.key]: findProject,
  },
  creates: {
    [createProject.key]: createProject,
    [getShareLinks.key]: getShareLinks,
  },
  resources: {},
};
