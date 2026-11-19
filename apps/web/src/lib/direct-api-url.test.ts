import { describe, expect, it } from "vitest";
import { directApiBaseUrl } from "./direct-api-url";

const local = { protocol: "http:", hostname: "127.0.0.1" };

describe("the webhook's direct API URL", () => {
  it("uses the port the API really listens on, not 4000", () => {
    expect(directApiBaseUrl({ apiPort: "4390", location: local, currentBase: "http://127.0.0.1:5390" })).toBe("http://127.0.0.1:4390");
  });

  it("offers nothing when the API port is unknown, rather than a guess", () => {
    expect(directApiBaseUrl({ location: local, currentBase: "http://127.0.0.1:5390" })).toBeNull();
    expect(directApiBaseUrl({ apiPort: "", location: local, currentBase: "http://127.0.0.1:5390" })).toBeNull();
  });

  it("offers nothing when the app already calls the API directly, or off a local host", () => {
    expect(directApiBaseUrl({ configuredBase: "https://api.example.com", apiPort: "4000", location: local, currentBase: "https://api.example.com" })).toBeNull();
    expect(directApiBaseUrl({ apiPort: "4000", location: { protocol: "https:", hostname: "studio.example.com" }, currentBase: "https://studio.example.com" })).toBeNull();
    expect(directApiBaseUrl({ apiPort: "5390", location: local, currentBase: "http://127.0.0.1:5390/" })).toBeNull();
  });
});
