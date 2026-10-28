// Links AetherEngine's dynamic binary frameworks (FFmpeg, dav1d, zimg, zvbi, libdovi) into the app
// target so they are linked and embedded in the .app.
// AetherEngine itself is NOT linked here: the MediahubPlayer pod depends on it via spm_dependency and
// Xcode merges its object code into that static library; linking the product again in the app gave
// duplicate symbols (CI run 40365617237).
const { withXcodeProject } = require("expo/config-plugins");

// Keep in step with what AetherEngine 7.48.0 resolves (Package.resolved: FFmpegBuild 3.10.x, LibDovi 2.1.x).
const PACKAGES = [
  {
    name: "FFmpegBuild",
    url: "https://github.com/superuser404notfound/FFmpegBuild",
    requirement: { kind: "upToNextMinorVersion", minimumVersion: "3.10.1" },
    products: ["AetherLibavcodec", "AetherLibavformat", "AetherLibavutil", "AetherLibswresample", "AetherLibswscale", "AetherLibavfilter", "AetherLibdav1d", "AetherLibzimg", "AetherLibzvbi"],
  },
  {
    name: "LibDovi",
    url: "https://github.com/superuser404notfound/LibDovi",
    requirement: { kind: "upToNextMinorVersion", minimumVersion: "2.1.0" },
    products: ["Dovi"],
  },
];

module.exports = function withAetherEngine(config) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const objects = project.hash.project.objects;
    objects.XCRemoteSwiftPackageReference = objects.XCRemoteSwiftPackageReference || {};
    objects.XCSwiftPackageProductDependency = objects.XCSwiftPackageProductDependency || {};
    const projKey = Object.keys(objects.PBXProject).find((k) => !k.endsWith("_comment"));
    const proj = objects.PBXProject[projKey];
    const target = project.getFirstTarget();
    const native = objects.PBXNativeTarget[target.uuid];
    const phase = project.pbxFrameworksBuildPhaseObj(target.uuid);
    if (!phase) throw new Error("with-aether-engine: app target has no Frameworks build phase");

    for (const pkg of PACKAGES) {
      const exists = Object.values(objects.XCRemoteSwiftPackageReference).some((v) => typeof v === "object" && String(v.repositoryURL).includes(pkg.url));
      if (exists) continue;
      const pkgId = project.generateUuid();
      const pkgComment = `XCRemoteSwiftPackageReference "${pkg.name}"`;
      objects.XCRemoteSwiftPackageReference[pkgId] = { isa: "XCRemoteSwiftPackageReference", repositoryURL: `"${pkg.url}"`, requirement: pkg.requirement };
      objects.XCRemoteSwiftPackageReference[`${pkgId}_comment`] = pkgComment;
      proj.packageReferences = [...(proj.packageReferences || []), { value: pkgId, comment: pkgComment }];

      for (const product of pkg.products) {
        const prodId = project.generateUuid();
        const fileId = project.generateUuid();
        objects.XCSwiftPackageProductDependency[prodId] = { isa: "XCSwiftPackageProductDependency", package: pkgId, package_comment: pkgComment, productName: product };
        objects.XCSwiftPackageProductDependency[`${prodId}_comment`] = product;
        objects.PBXBuildFile[fileId] = { isa: "PBXBuildFile", productRef: prodId, productRef_comment: product };
        objects.PBXBuildFile[`${fileId}_comment`] = `${product} in Frameworks`;
        native.packageProductDependencies = [...(native.packageProductDependencies || []), { value: prodId, comment: product }];
        phase.files.push({ value: fileId, comment: `${product} in Frameworks` });
      }
    }
    return cfg;
  });
};
