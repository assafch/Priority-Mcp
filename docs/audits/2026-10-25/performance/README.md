# Offline performance and intelligence baseline

Measured against `29f89590b567db66949564ac2c083d65dfc6f772` (Priority MCP 0.2.0), Node 26.4.0. The synthetic fixtures used no environment file, real credentials, live Priority request or ERP mutation. Production source/configuration was not changed.

- [Original measurements](baseline.json)
- [Reproducer](reproduce.mjs)
- [Design](../../../superpowers/specs/2026-10-25-mcp-faster-smarter-design.md)
- [Full execution plan](../../../superpowers/plans/2026-10-25-mcp-faster-smarter.md)

Run from a built baseline checkout with a fresh output path:

```sh
node docs/audits/2026-10-25/performance/reproduce.mjs --output /tmp/priority-performance-replay.json
```

The script refuses to overwrite an existing result. It is a baseline diagnostic, not a regression suite that asserts bugs should remain. Future implementation gets maintained benchmarks and corrected golden expectations in Task 1.

## Interpretation

| Measurement | Observation | Does not prove |
| --- | --- | --- |
| Concurrent reads | 20 identical requests caused 20 backend fetches; warm repeat caused 0 | A 20x latency improvement is achievable |
| Search | Match at row 250 missed when first page had only 100/500 requested rows and a next link | Current production customers/products were actually missed |
| Schema | Single-entity schema handler called full `$metadata` | Current live metadata bytes or latency |
| Discovery | 105 tools, 113,577 serialized bytes; 24 unavailable | Actual token cost or model tool-selection error rate |
| Capability pages | Three calls, 94,189 combined serialized bytes for all entries at requested top=100 | Host necessarily includes text and structured content twice in model input |
| Formatting | 1MiB/20,000-row fixture, median 14.655ms, p95 15.673ms across 10 runs | Production p95, memory consumption or CPU saturation |

A replay after formatting the diagnostic produced the same deterministic counts and search/schema outcomes. Timings varied as expected. Biome passed on 112 files. No application test was changed to accommodate these findings.

## Design review

An independent builder reviewed the design. Four important questions were resolved before handoff:

1. Profile visibility and explicit authorization are distinct; workflow components still pass policy checks.
2. Scheduler rateScope is separate from data scope, with operator mapping for multiple credentials belonging to one API user.
3. Index candidates require a current uncached authorized read before names/IDs are exposed.
4. Report resume replaces specified windows and explicitly reports multi-observation consistency rather than claiming a database snapshot.

Final review verdict: **ready for planning handoff; nothing important left**. This approves design clarity, not implemented performance or tenant behavior.

## Primary references checked on 2026-10-25

- [Priority targeted metadata](https://prioritysoftware.github.io/restapi/request/)
- [Priority fair-use limits and paging](https://prioritysoftware.github.io/restapi/)
- [Priority change queries](https://prioritysoftware.github.io/restapi/query/)
- [Priority batch behavior](https://prioritysoftware.github.io/restapi/modify/)
- [Priority webhook prerequisites](https://prioritysoftware.github.io/webhooks)
- [Official Priority MCP eligibility](https://prioritysoftware.github.io/mcp/)
- [Installed-version MCP tool contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP progress contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [Newer MCP tool contract for a separate compatibility study](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
