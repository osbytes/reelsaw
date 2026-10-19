# Licensing

Reelsaw is open-core. Which licence applies depends on where a file lives:

| Path | Licence |
| --- | --- |
| Everything not listed below | [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`) |
| `apps/server/src/ee/` and `apps/web/src/ee/` | The Reelsaw Enterprise License in the `LICENSE` file of each folder |

The `ee/` folders hold the hosted service's additions (billing through Stripe today; see
[docs/specs/ee.md](docs/specs/ee.md)). They ship in the same image as everything else and run
only when `REELSAW_EE=true`; a self-hosted install never loads them. You may read, modify and run
that code for development and testing; running it in production needs an agreement with osbytes.

Everything a person needs to run Reelsaw for themselves or for many people (accounts, approval,
quotas, usage, retention, the watermark, MCP, the CLI) is in the AGPL part.

The `ee/` code is compiled into the same image and the same web bundle as the AGPL code (a dynamic
import on the server, a lazy chunk in the browser), so a self-hosted install has it on disk but never
loads it. Having it there is allowed by its licence (copying for development and testing is free;
only production use needs an agreement), and a self-hosted install never uses it in production.

Combining AGPL code with the separately licensed `ee/` in one distributed work needs the right to
distribute every contribution under both licences. A DCO sign-off alone certifies the right to
submit under the AGPL; it does not grant that. So contributors sign the
[Contributor License Agreement](CLA.md) once (a line in `.github/cla-signatures.json` in their
first pull request; they keep their copyright), and every commit still carries the DCO sign-off.
CI enforces both (`.github/workflows/contributors.yml`), and `main` requires those checks.
