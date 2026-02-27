import * as p from "@clack/prompts";
import { MatrixAuth, RustSdkCryptoStorageProvider } from "matrix-bot-sdk";

async function main() {
	p.intro("🔑 Matrix Token Generator");

	const homeserverUrl = await p.text({
		message: "Homeserver URL",
		placeholder: "https://matrix.org",
		initialValue: "https://matrix.org",
	});
	if (p.isCancel(homeserverUrl)) process.exit(0);

	const username = await p.text({
		message: "Username (full Matrix ID)",
		placeholder: "@user:matrix.org",
	});
	if (p.isCancel(username)) process.exit(0);

	const password = await p.password({
		message: "Password",
	});
	if (p.isCancel(password)) process.exit(0);

	const spinner = p.spinner();
	spinner.start("Logging in...");

	try {
		const auth = new MatrixAuth(homeserverUrl as string);
		const client = await auth.passwordLogin(
			username as string,
			password as string,
			"LettaBot",
		);
		const who = await client.getWhoAmI();

		spinner.stop("Login successful!");

		p.note(
			`Access Token:\n${client.accessToken}\n\n` +
				`Device ID:\n${who.device_id}\n\n` +
				`Homeserver:\n${homeserverUrl}`,
			"✅ Credentials Generated",
		);

		p.log.info("Add these to your .env file:");
		p.log.info(`MATRIX_HOMESERVER_URL=${homeserverUrl}`);
		p.log.info(`MATRIX_ACCESS_TOKEN=${client.accessToken}`);
	} catch (err: any) {
		spinner.stop("Login failed");
		p.log.error(err.message || String(err));
		if (err.body) {
			console.error(JSON.stringify(err.body, null, 2));
		}
	}
}

main().catch(console.error);
