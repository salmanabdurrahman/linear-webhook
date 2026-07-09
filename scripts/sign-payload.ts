import { hmacSha256Hex } from "../src/crypto";

export interface Options {
  secret: string;
  url: string;
  type: string;
  action: string;
}

export function parseArgs(args: string[], envSecret: string | undefined): Options {
  const options: Options = {
    secret: envSecret ?? "test-linear-webhook-secret",
    url: "http://localhost:8787/webhooks/linear",
    type: "Issue",
    action: "create",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];

    if (arg === "--secret" && value) {
      options.secret = value;
      index += 1;
    } else if (arg === "--url" && value) {
      options.url = value;
      index += 1;
    } else if (arg === "--type" && value) {
      options.type = value;
      index += 1;
    } else if (arg === "--action" && value) {
      options.action = value;
      index += 1;
    } else if (arg === "--help") {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return options;
}

export async function buildCurlCommand(options: Options, now = Date.now()): Promise<string> {
  const payload = JSON.stringify({
    webhookTimestamp: now,
    type: options.type,
    action: options.action,
    actor: { name: "Local Test" },
    data: { title: "Manual signed payload", body: "Generated for local verification" },
    url: "https://linear.app/example/issue/SAL-1",
  });
  const signature = await hmacSha256Hex(options.secret, payload);

  return `curl -i ${shellQuote(options.url)} \\\n  -X POST \\\n  -H 'Content-Type: application/json' \\\n  -H 'Linear-Signature: sha256=${signature}' \\\n  -H 'Linear-Delivery: local-delivery' \\\n  -H 'Linear-Event: ${options.type}' \\\n  --data ${shellQuote(payload)}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), process.env["LINEAR_WEBHOOK_SECRET"]);
  console.log(await buildCurlCommand(options));
}

function printHelpAndExit(): never {
  console.log("Usage: LINEAR_WEBHOOK_SECRET=value bun run sign:payload -- [--url value] [--type Issue] [--action create]");
  process.exit(0);
}

if (import.meta.main) {
  await main();
}
