const fs = require("fs");
const path = require("path");
const fse = require("fs-extra");
const vm = require("vm");
const utilscripts = require("./utilscripts");
const process = require("process");

/*global basePath */
let basePath = null;

var appConfig, appConfigFile, rProfileFile, wProfileFile, profile;

exports.setBasePath = function(appRoot) {
  basePath = path.join(appRoot, "build-src");
};

function isTest(test, e, i, isThemeWidget, isOnscreen) {
  switch (test) {
    case "onScreenOffPanelWidget":
      return (
        !e.widgets &&
        e.uri &&
        e.visible !== false &&
        !isThemeWidget &&
        !widgetIsInPanel(e.uri) &&
        isOnscreen
      );
    case "themeOffPanelWidget":
      return (
        !e.widgets &&
        e.uri &&
        e.visible !== false &&
        isThemeWidget &&
        !widgetIsInPanel(e.uri)
      );
    case "inPanelWidget":
      return (
        !e.widgets &&
        e.uri &&
        e.visible !== false &&
        !isThemeWidget &&
        widgetIsInPanel(e.uri)
      );
    case "offPanelWidget":
      return (
        !e.widgets && e.uri && e.visible !== false && !widgetIsInPanel(e.uri)
      );
    case "themeWidget":
      return !e.widgets && e.uri && e.visible !== false && isThemeWidget;
    case "widget":
      return !e.widgets && e.uri && e.visible !== false;
  }
}

exports.setInfo = function(info) {
  if (info.appConfigFile) {
    appConfigFile = info.appConfigFile;
  } else {
    appConfigFile = path.join(basePath, "config.json");
  }

  appConfig = fse.readJsonSync(appConfigFile, "utf-8");
  appConfig._buildInfo = {};

  rProfileFile = path.join(__dirname, "_app.profile.js");
  wProfileFile = path.join(basePath, "app.profile.js");

  var profileStr = fs.readFileSync(rProfileFile, "utf-8");
  profile = vm.runInThisContext(profileStr);
};

exports.prepare = function() {
  addBuildLayers();
  addBuildFiles();

  utilscripts.writeThemeResourceModule(basePath, appConfig);
  writeAllWidgetResourceModules();

  mergeAndWriteWidgetManifests();

  writeAppConfig();
  writeProfile();
};

function writeAppConfig() {
  var segs = appConfigFile.split(path.sep);
  segs.pop();
  var appConfigPath = segs.join(path.sep);
  fse.writeJsonSync(
    path.join(appConfigPath, "build-src", "_build-generate_config.json"),
    appConfig,
    "utf-8"
  );
}

function writeProfile() {

  function replacer(key, value) {
    // wrap RegExp so we can find later
    if (value instanceof RegExp) {
      return ("__REGEXP " + value.toString() +  " REGEXP__");
    }
    else
      return value;
  }

  // use replacer function to wrap any RegEx so we can find it
  var tmpProfileStr = "profile = " + JSON.stringify(profile, replacer, 2) + ";";
  // convert back to RegEx before writing to file
  var profileStr = tmpProfileStr.replace(/"__REGEXP (.*) REGEXP__"/g, function(match, p1) {
    // unescape backslashes since this was stringified
    return p1.replace(/\\\\/g,"\\");
  });
  fs.writeFileSync(wProfileFile, profileStr, "utf-8");
}

////////////////layers
function addBuildLayers() {
  var dynamicLayers = getAllWidgetsLayers();
  dynamicLayers.push(getThemeLayer());

  dynamicLayers.forEach(function(layer) {
    profile.layers[layer.name] = {
      include: layer.include,
      exclude: layer.exclude
    };
  });

  var preloadLayers = getPreloadLayers();
  preloadLayers.forEach(function(layer) {
    profile.layers["dynamic-modules/preload"].include.push(layer.name);
  });

  var postloadLayers = getPostLoadLayers();
  postloadLayers.forEach(function(layer) {
    profile.layers["dynamic-modules/postload"].include.push(layer.name);
  });
}

function getPreloadLayers() {
  var layers = [];

  layers.push(getThemeLayer());
  //all off panel widget
  utilscripts.visitElement(appConfig, function(
    e,
    i,
    isThemeWidget,
    isOnscreen
  ) {
    if (!isTest("offPanelWidget", e, i, isThemeWidget, isOnscreen)) {
      return;
    }
    var layer = {};
    layer.name = e.uri;
    layers.push(layer);
  });
  return layers;
}

function getPostLoadLayers() {
  var layers = [];

  //all in panel widget
  utilscripts.visitElement(appConfig, function(
    e,
    i,
    isThemeWidget,
    isOnscreen
  ) {
    if (!isTest("inPanelWidget", e, i, isThemeWidget, isOnscreen)) {
      return;
    }
    var layer = {};
    layer.name = e.uri;
    layers.push(layer);
  });
  return layers;
}

function getThemeLayer() {
  var layer = {};
  layer.name = "themes/" + appConfig.theme.name + "/main";
  layer.include = [
    "themes/" + appConfig.theme.name + "/_build-generate_module"
  ];
  layer.exclude = ["jimu/main", "libs/main", "esri/main"];
  return layer;
}

function getAllWidgetsLayers() {
  var layers = [];
  utilscripts.visitElement(appConfig, function(
    e,
    i,
    isThemeWidget,
    isOnscreen
  ) {
    if (!isTest("widget", e, i, isThemeWidget, isOnscreen)) {
      return;
    }
    var layer = {};
    layer.name = e.uri;
    layer.include = [
      utilscripts.getAmdFolderFromUri(e.uri) + "/_build-generate_module"
    ];
    layer.exclude = ["jimu/main", "libs/main", "esri/main"];
    layers.push(layer);
  });
  return layers;
}

/////////////build files
function addBuildFiles() {
  if (!profile.files) {
    profile.files = [];
  }

  profile.files.push([
    "./widgets/_build-generate_widgets-manifest.json",
    "./widgets/widgets-manifest.json"
  ]);
  profile.files.push(["./_build-generate_config.json", "./config.json"]);
}

/////////////////widget module
function writeAllWidgetResourceModules() {
  utilscripts.visitElement(appConfig, function(
    e,
    i,
    isThemeWidget,
    isOnscreen
  ) {
    if (!isTest("widget", e, i, isThemeWidget, isOnscreen)) {
      return;
    }
    utilscripts.writeWidgetResourceModule(basePath, e);
  });
}

//////////////////////widget manifest
function mergeAndWriteWidgetManifests() {
  var resultJson = {};

  utilscripts.visitElement(appConfig, function(e) {
    if (!e.uri) {
      return;
    }
    var segs = e.uri.split("/");
    segs.pop();
    var widgetFolder = segs.join("/");
    var manifestFile = path.join(basePath, widgetFolder, "manifest.json");
    var manifestJson = fse.readJsonSync(manifestFile, "utf-8");
    manifestJson.location = path.join(basePath, widgetFolder);
    manifestJson.category = "widget";
    if (manifestJson.featureActions) {
      utilscripts.addI18NFeatureActionsLabel(manifestJson);
    }
    utilscripts.addI18NLabel(manifestJson);

    delete manifestJson.location;
    resultJson[e.uri] = manifestJson;
  });

  appConfig._buildInfo.widgetManifestsMerged = true;

  fse.writeJsonSync(
    path.join(basePath, "widgets/_build-generate_widgets-manifest.json"),
    resultJson,
    "utf-8"
  );
}

function widgetIsInPanel(uri) {
  var segs = uri.split("/");
  segs.pop();
  var folder = segs.join("/");
  var manifestFile = path.join(basePath, folder, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    var manifest = fse.readJsonSync(manifestFile, "utf-8");
    if (manifest.properties && manifest.properties.inPanel === false) {
      return false;
    } else {
      return true;
    }
  }
  return true;
}
