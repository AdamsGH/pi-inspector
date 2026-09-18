import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** Choose one reachable display address without changing the listening interface. */
export function displayAddress(
	host: string,
	url: string,
	interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces(),
): string {
	const local = new URL(url);
	let address = host;
	if (host === "0.0.0.0" || host === "::") {
		const candidates = Object.values(interfaces)
			.flatMap((entries) => entries ?? [])
			.filter((entry) => !entry.internal && !entry.address.includes("%"));
		const ipv4 = candidates.filter((entry) => entry.family === "IPv4");
		const lan = ipv4.find((entry) => {
			const [first, second] = entry.address.split(".").map(Number);
			return (
				first === 10 ||
				(first === 172 && second! >= 16 && second! <= 31) ||
				(first === 192 && second === 168)
			);
		});
		const ipv6 = candidates.find(
			(entry) => entry.family === "IPv6" && !/^fe[89ab]/i.test(entry.address),
		);
		address = (host === "::" ? ipv6 : (lan ?? ipv4[0]))?.address ?? local.hostname;
	}
	const formatted = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
	return `${formatted}:${local.port || "80"}`;
}
