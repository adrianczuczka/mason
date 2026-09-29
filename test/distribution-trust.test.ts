import tls from "node:tls";
import { afterEach, expect, it, vi } from "vitest";
import { configureSystemTrust } from "../src/distribution/trust.js";

vi.mock("node:tls", () => ({ default: {
  getCACertificates: vi.fn((type: string) => type === "system" ? ["company"] : ["bundled", "extra"]),
  setDefaultCACertificates: vi.fn(),
} }));
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it("adds system trust while preserving bundled and extra certificates", () => {
  vi.stubEnv("NODE_USE_SYSTEM_CA", undefined);
  configureSystemTrust();
  expect(tls.setDefaultCACertificates).toHaveBeenCalledWith(["bundled", "extra", "company"]);
});

it("honors an explicit opt-out", () => {
  vi.stubEnv("NODE_USE_SYSTEM_CA", "0");
  configureSystemTrust();
  expect(tls.getCACertificates).not.toHaveBeenCalled();
  expect(tls.setDefaultCACertificates).not.toHaveBeenCalled();
});
