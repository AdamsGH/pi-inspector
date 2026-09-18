import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { test } from "node:test";
import { displayAddress } from "../src/address.ts";

function address(
  ip: string,
  family: "IPv4" | "IPv6" = "IPv4",
  internal = false,
): NetworkInterfaceInfo {
  return {
    address: ip,
    family,
    internal,
    netmask: "",
    mac: "",
    cidr: null,
  } as NetworkInterfaceInfo;
}

test("wildcard display selects one LAN address instead of listing CGNAT interfaces", () => {
  const interfaces = {
    lo: [address("127.0.0.1", "IPv4", true)],
    vpn: [address("100.64.9.1")],
    lan: [address("10.145.0.50")],
    bridge: [address("100.64.4.1"), address("100.64.7.1")],
  };
  assert.equal(
    displayAddress("0.0.0.0", "http://127.0.0.1:23500", interfaces),
    "10.145.0.50:23500",
  );
  for (const ip of ["172.16.0.5", "172.31.0.5", "192.168.1.5"]) {
    assert.equal(
      displayAddress("0.0.0.0", "http://127.0.0.1:23500", {
        vpn: interfaces.vpn,
        lan: [address(ip)],
      }),
      `${ip}:23500`,
    );
  }
});

test("explicit bindings are preserved and wildcard without LAN has usable fallback", () => {
  assert.equal(displayAddress("10.0.0.2", "http://10.0.0.2:80", {}), "10.0.0.2:80");
  assert.equal(displayAddress("127.0.0.1", "http://127.0.0.1:23500", {}), "127.0.0.1:23500");
  assert.equal(displayAddress("0.0.0.0", "http://127.0.0.1:23500", {}), "127.0.0.1:23500");
  assert.equal(
    displayAddress("0.0.0.0", "http://127.0.0.1:23500", { vpn: [address("100.64.1.1")] }),
    "100.64.1.1:23500",
  );
});

test("IPv6 display is bracketed and ignores link-local addresses", () => {
  assert.equal(displayAddress("::1", "http://[::1]:23500", {}), "[::1]:23500");
  assert.equal(
    displayAddress("::", "http://[::1]:23500", {
      lan: [address("fe80::1", "IPv6"), address("fd00::5", "IPv6")],
    }),
    "[fd00::5]:23500",
  );
  assert.equal(displayAddress("::", "http://[::1]:23500", {}), "[::1]:23500");
});
