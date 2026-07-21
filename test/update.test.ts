import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { packageSpec, PACKAGE_NAME } from "../src/update.js";

describe("packageSpec", () => {
  it("defaults to @latest", () => {
    assert.equal(packageSpec(), `${PACKAGE_NAME}@latest`);
    assert.equal(packageSpec(""), `${PACKAGE_NAME}@latest`);
    assert.equal(packageSpec("   "), `${PACKAGE_NAME}@latest`);
  });

  it("accepts dist-tags and versions", () => {
    assert.equal(packageSpec("latest"), `${PACKAGE_NAME}@latest`);
    assert.equal(packageSpec("next"), `${PACKAGE_NAME}@next`);
    assert.equal(packageSpec("1.2.3"), `${PACKAGE_NAME}@1.2.3`);
  });

  it("strips a leading v from semver only", () => {
    assert.equal(packageSpec("v1.2.3"), `${PACKAGE_NAME}@1.2.3`);
    assert.equal(packageSpec("v2.0.0-beta.1"), `${PACKAGE_NAME}@2.0.0-beta.1`);
  });

  it("passes through a full package@spec", () => {
    assert.equal(packageSpec(`${PACKAGE_NAME}@1.0.0`), `${PACKAGE_NAME}@1.0.0`);
  });

  it("maps bare package names to @latest", () => {
    assert.equal(packageSpec(PACKAGE_NAME), `${PACKAGE_NAME}@latest`);
    assert.equal(packageSpec("disk-agent"), `${PACKAGE_NAME}@latest`);
  });
});
