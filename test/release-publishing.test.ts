import { describe, expect, it } from "vitest";
import { validateRelease, validateNpm, validateRegistry, registryAlreadyPublished } from "../scripts/verify-release.mjs";

function fixture() {
  const pkg = { name: "mason-context", version: "1.2.3", mcpName: "com.adrianczuczka/mason" };
  const server = {
    name: pkg.mcpName,
    version: pkg.version,
    packages: [{ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } }],
  };
  return { pkg, server };
}

describe("release publication guards", () => {
  it("accepts matching release metadata", () => {
    const { pkg, server } = fixture();
    expect(() => validateRelease(pkg, server, "v1.2.3")).not.toThrow();
  });

  it("rejects a different release tag", () => {
    const { pkg, server } = fixture();
    expect(() => validateRelease(pkg, server, "v1.2.2")).toThrow("Release tag");
  });

  it.each(["server", "package"])("rejects a stale %s version in server.json", field => {
    const { pkg, server } = fixture();
    if (field === "server") server.version = "1.2.2";
    else server.packages[0].version = "1.2.2";
    expect(() => validateRelease(pkg, server, "v1.2.3")).toThrow(/version/);
  });

  it("rejects a package that cannot verify ownership of the registry name", () => {
    const { pkg, server } = fixture();
    pkg.mcpName = "io.github.adrianczuczka/mason";
    expect(() => validateRelease(pkg, server, "v1.2.3")).toThrow("mcpName");
  });

  it("rejects a namespace that the configured DNS key cannot publish to", () => {
    const { pkg, server } = fixture();
    pkg.mcpName = server.name = "io.github.adrianczuczka/mason";
    expect(() => validateRelease(pkg, server, "v1.2.3")).toThrow("domain authentication");
  });

  it("rejects a different npm package in the manifest", () => {
    const { pkg, server } = fixture();
    server.packages[0].identifier = "another-package";
    expect(() => validateRelease(pkg, server, "v1.2.3")).toThrow("identifier");
  });

  it("requires the exact npm release and its ownership metadata", () => {
    const { pkg } = fixture();
    expect(() => validateNpm(pkg, { ...pkg })).not.toThrow();
    expect(() => validateNpm(pkg, { ...pkg, version: "1.2.2" })).toThrow("not available");
    expect(() => validateNpm(pkg, { ...pkg, mcpName: undefined })).toThrow("mcpName");
  });

  it("verifies the live registry version, package metadata and active status", () => {
    const { server } = fixture();
    const response = {
      server: structuredClone(server),
      _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false } },
    };
    // An exact-version retry must work even after a newer release exists.
    expect(() => validateRegistry(server, response)).not.toThrow();
    response.server.version = "1.2.2";
    expect(() => validateRegistry(server, response)).toThrow("version differs");
    response.server = structuredClone(server);
    response.server.packages[0].version = "1.2.2";
    expect(() => validateRegistry(server, response)).toThrow("package metadata");
    response.server = structuredClone(server);
    response._meta["io.modelcontextprotocol.registry/official"].status = "deleted";
    expect(() => validateRegistry(server, response)).toThrow("not active");
  });

  it("only publishes a missing version and safely skips a matching active version", () => {
    const { server } = fixture();
    const response = { server, _meta: { "io.modelcontextprotocol.registry/official": { status: "active" } } };
    expect(registryAlreadyPublished(server, 404, null)).toBe(false);
    expect(registryAlreadyPublished(server, 200, response)).toBe(true);
    expect(() => registryAlreadyPublished(server, 503, null)).toThrow("HTTP 503");
    expect(() => registryAlreadyPublished(server, 403, null)).toThrow("HTTP 403");
    expect(() => registryAlreadyPublished(server, 200, { ...response, server: { ...server, packages: [] } })).toThrow("package metadata");
  });
});
