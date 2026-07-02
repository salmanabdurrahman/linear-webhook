import { hmacSha256Hex } from "../src/crypto";

interface Options {
  secret: string;
  url: string;
  type: string;
  action: string;
}

const options = parseArgs(process.argv.slice(2), process.env.LINEAR_WEBHOOK_SECRET);
const payload = JSON.stringify({
  webhookTimestamp: Date.now(),
  type: options.type,
  action: options.action,
  actor: { name: "Local Test" },
  data: { title: "Manual signed payload", body: "Generated for local verification" },
  url: "https://linear.app/example/issue/SAL-1",
});
const signature = await hmacSha256Hex(options.secret, payload);

console.log(`curl -i ${shellQuote(options.url)} \\\n  -X POST \\\n  -H 'Content-Type: application/json' \\\n  -H 'Linear-Signature: sha256=${signature}' \\\n  -H 'Linear-Delivery: local-delivery' \\\n  -H 'Linear-Event: ${options.type}' \\\n  --data ${shellQuote(payload)}`);

function parseArgs(args: string[], envSecret: string | undefined): Options {
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function printHelpAndExit(): never {
  console.log("Usage: LINEAR_WEBHOOK_SECRET=value bun run sign:payload -- [--url value] [--type Issue] [--action create]");
  process.exit(0);
}
