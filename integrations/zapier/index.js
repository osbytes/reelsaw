"use strict";

const authentication = require("./authentication");
const { befores, afters } = require("./lib/middleware");
const projectDone = require("./triggers/project_done");
const clipDone = require("./triggers/clip_done");
const projectFailed = require("./triggers/project_failed");
const createProject = require("./creates/create_project");
const getShareLinks = require("./creates/get_share_links");
const findProject = require("./searches/find_project");
const projectList = require("./triggers/project_list");
const clipList = require("./triggers/clip_list");

module.exports = {
  version: require("./package.json").version,
  platformVersion: require("zapier-platform-core").version,

  authentication,
  // inputs reach Reelsaw as typed: titles, metadata values and URLs are not trimmed or reshaped by the platform
  flags: { cleanInputData: false },
  beforeRequest: [...befores],
  afterResponse: [...afters],

  triggers: {
    [projectDone.key]: projectDone,
    [clipDone.key]: clipDone,
    [projectFailed.key]: projectFailed,
    // hidden: dropdowns for Project ID / Clip ID inputs
    [projectList.key]: projectList,
    [clipList.key]: clipList,
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
