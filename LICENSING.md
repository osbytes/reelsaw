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
quotas, usage, retention, the watermark, MCP, the CLI) is in the AGPL part. Contributions carry a
DCO sign-off ([CONTRIBUTING.md](CONTRIBUTING.md)), which is what lets the project keep one
repository with two licences.
