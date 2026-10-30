import { whoAmI, GithubError } from "./github.js";

/** A message the person can fix and retry (a wrong token), as opposed to a bug. */
export class ConnectorError extends Error {}

export type Field = { key: string; label: string; secret: boolean; placeholder?: string };
export type ConnectorDef = {
  id: string;
  name: string;
  blurb: string;
  fields: Field[];
  /** Plain steps for getting what the fields ask for. */
  steps: string[];
  helpUrl: string;
  /** Checks the values really work and returns a label to show (an account name). Throws ConnectorError if not. */
  verify(values: Record<string, string>, fetchFn: typeof fetch): Promise<string>;
};

/**
 * Connectors that need a key or token the person pastes in. Adding one means adding an entry here and the tools that use it:
 * the Connections screen, the encrypted storage, the connect and disconnect buttons and the checks all come with it.
 * (Google is different: it signs in with a button, see routes/google.ts.)
 */
export const CONNECTORS: ConnectorDef[] = [
  {
    id: "github",
    name: "GitHub",
    blurb: "See what's waiting on you: reviews people asked for, issues assigned to you, and your open pull requests. In your briefing too. Read only.",
    fields: [{ key: "token", label: "Personal access token", secret: true, placeholder: "ghp_… or github_pat_…" }],
    steps: [
      "Open GitHub, then Settings, Developer settings, Personal access tokens.",
      "Make a token. For a classic token, tick only 'repo' (or 'public_repo' if you only use public repos). For a fine-grained token, give it read access to Issues and Pull requests.",
      "Copy the token and paste it here. GitHub only shows it once.",
    ],
    helpUrl: "https://github.com/settings/tokens",
    async verify(values, fetchFn) {
      const token = (values.token ?? "").trim();
      if (token.length < 20 || /\s/.test(token)) throw new ConnectorError("That doesn't look like a GitHub token. Copy the whole thing, with no spaces.");
      try {
        return `@${await whoAmI(token, fetchFn)}`;
      } catch (e) {
        if (e instanceof GithubError) throw new ConnectorError(e.kind === "reconnect" ? "GitHub didn't accept that token. Check it's copied in full and hasn't expired." : e.message);
        throw e;
      }
    },
  },
];

export const connectorById = (id: string) => CONNECTORS.find((c) => c.id === id);
