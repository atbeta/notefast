# Changelog

## [0.21.0](https://github.com/atbeta/notefast/compare/v0.20.0...v0.21.0) (2026-07-27)


### Features

* **server,web:** doc sharing with public read-only links and expiry ([a77bbde](https://github.com/atbeta/notefast/commit/a77bbde528d63266bb53b3b87d67373283b9c131))


### Bug Fixes

* **web:** canonicalize pinned view query to fix double-question-mark links ([edba68d](https://github.com/atbeta/notefast/commit/edba68df6b0d53bb35b8b8819791605a80e6d508))
* **web:** stale-while-revalidate in useApiQuery to kill skeleton flash on view switches ([07d3f13](https://github.com/atbeta/notefast/commit/07d3f13c7f20308c78f756a05ec4e66d6bac1a50))

## [0.20.0](https://github.com/atbeta/notefast/compare/v0.19.0...v0.20.0) (2026-07-27)


### Features

* **server,web,core:** smart view presets, archived search, chat robustness ([353fdeb](https://github.com/atbeta/notefast/commit/353fdebd4a327b78f9227f4dac2a22db5237fa41))


### Bug Fixes

* **server,web:** keep SSE alive past Bun idleTimeout; show pinned views ([acdc8c6](https://github.com/atbeta/notefast/commit/acdc8c67b1637b2b61bc7b5757aafb3278f80407))

## [0.19.0](https://github.com/atbeta/notefast/compare/v0.18.0...v0.19.0) (2026-07-27)


### Features

* **server,web:** built-in chat skills with list_docs tool ([2f5f159](https://github.com/atbeta/notefast/commit/2f5f1592b5a106846992baf6f205589f9eab64d0))
* **server,web:** image attachments in AI chat ([008acb6](https://github.com/atbeta/notefast/commit/008acb6132b87ff31d04132fe2de3033b4bb65b9))
* **server,web:** image understanding at index time (captions in vectors) ([45b1871](https://github.com/atbeta/notefast/commit/45b1871cdbfdbe37f91c26f49ceaeca5fb922acd))
* **server:** reserve source provenance for future connectors ([b16296a](https://github.com/atbeta/notefast/commit/b16296a18560b4c8a4eee5f6b3261fdaf20d314d))
* **web:** speech-to-text input in AI chat panel ([6c60d69](https://github.com/atbeta/notefast/commit/6c60d6978f14f0bb67c3c00d5054dbfa75cff94f))

## [0.18.0](https://github.com/atbeta/notefast/compare/v0.17.2...v0.18.0) (2026-07-26)


### Features

* **server,web:** archived doc status with retrieval soft-exclusion ([aff2147](https://github.com/atbeta/notefast/commit/aff214767580251d8420c4f2b4399c598f31ef5c))
* **server,web:** push doc changes over SSE for instant list refresh ([7dbe3f4](https://github.com/atbeta/notefast/commit/7dbe3f43a102b9c8e675c43c850236fd95bea607))


### Bug Fixes

* **ai:** parse appended markdown into structured blocks in notefast_append_to_doc ([d83206a](https://github.com/atbeta/notefast/commit/d83206a8d53c9e28475a6f53cbd03a99d71d8e71))
* **api:** preserve block properties on PUT /docs/:id/markdown ([87148f1](https://github.com/atbeta/notefast/commit/87148f188e39ae553d57fd3050ca6dce98d5c461))
* **server,web:** rebuild vectors asynchronously when restoring AI visibility ([8029e57](https://github.com/atbeta/notefast/commit/8029e576c98419fd15a38e5135926f3dc1b0547d))
* **web:** chat panel polish — empty bubble while thinking, retrieval footer labels ([003dd08](https://github.com/atbeta/notefast/commit/003dd085e393a4b2df61b0c80f2d50c4d1e244ae))
* **web:** keep settings button pinned to bottom in collapsed sidebar ([a8e8ad7](https://github.com/atbeta/notefast/commit/a8e8ad79fc574f51d16b10800ef569e6cf61fbd5))

## [0.17.2](https://github.com/atbeta/notefast/compare/v0.17.1...v0.17.2) (2026-07-26)


### Bug Fixes

* **ai:** read webSearch API key from runtime, not publicView ([b613013](https://github.com/atbeta/notefast/commit/b6130133c442f64b24e9c821426b64096cf2259b))
* **web:** cleanup settings page — remove duplicate titles, fix empty space ([b84c471](https://github.com/atbeta/notefast/commit/b84c4719984b324936feb0e00ff3a1910443e9b9))
* **web:** delay skeleton screen to prevent flash on fast navigation ([d346544](https://github.com/atbeta/notefast/commit/d34654405c5ebfd41d046848441cfc1850bc34c5))

## [0.17.1](https://github.com/atbeta/notefast/compare/v0.17.0...v0.17.1) (2026-07-26)


### Bug Fixes

* **ai:** remove Accept-Encoding header causing Brave Search 422 ([55da963](https://github.com/atbeta/notefast/commit/55da96316c556a723eabd5c478b882fb98089af5))
* **server:** disable rate limiting by default for single-user mode ([28a883d](https://github.com/atbeta/notefast/commit/28a883de7fbb6d90f328c4271cbea628b8f0d8e4))
* **web:** keep Settings icon in collapsed sidebar ([5387d41](https://github.com/atbeta/notefast/commit/5387d41737c3e4904079205df70a3d9a0ccf5625))
* **web:** remove stale content dimming when switching documents ([d1bfc34](https://github.com/atbeta/notefast/commit/d1bfc3432f9daceca84451a70058ddb4dd3a9e97))
* **web:** stabilize hook references to prevent infinite re-render loops ([46df378](https://github.com/atbeta/notefast/commit/46df3780f0189e19cff5284282c8577ad8e68636))

## [0.17.0](https://github.com/atbeta/notefast/compare/v0.16.0...v0.17.0) (2026-07-25)


### Features

* **ai:** add web search config UI in AI settings panel ([dad96ee](https://github.com/atbeta/notefast/commit/dad96eef29b2c0da4faba473669dc6c41c973001))


### Bug Fixes

* **doc:** skip stale-while-revalidate dim on fast doc switches ([80a8d66](https://github.com/atbeta/notefast/commit/80a8d66f7d329e282d6b8452bae331a73a802a78))

## [0.16.0](https://github.com/atbeta/notefast/compare/v0.15.1...v0.16.0) (2026-07-25)


### Features

* **ai:** AI writing continuation in editor + agent write tools in chat loop ([5b9b725](https://github.com/atbeta/notefast/commit/5b9b725629c5c3f790b6af7ca0500a94d8ad4e32))
* **ai:** expose notefast_update_block in chat agent loop ([1cccdbc](https://github.com/atbeta/notefast/commit/1cccdbc7aa7e994367c61974a9ff1a6713370f2c))
* **ai:** web search capability in chat agent loop ([e9dbaca](https://github.com/atbeta/notefast/commit/e9dbaca44673bd57ce79f3503cc8515668eec23b))

## [0.15.1](https://github.com/atbeta/notefast/compare/v0.15.0...v0.15.1) (2026-07-24)


### Bug Fixes

* **ai-chat:** move groupedCitations useMemo above the isOpen early return ([5352cc5](https://github.com/atbeta/notefast/commit/5352cc5c8057967869a964fb474c04884046f27b))

## [0.15.0](https://github.com/atbeta/notefast/compare/v0.14.3...v0.15.0) (2026-07-24)


### Features

* **ai-chat:** confirm clear, unlock input during stream, group citations ([2effeb7](https://github.com/atbeta/notefast/commit/2effeb7105bcbb64e3120eaca9fa054967b14b7b))
* **ai-chat:** swap capability badges from text to icons ([e42dbfa](https://github.com/atbeta/notefast/commit/e42dbfaf2ddcabd95da0723415c6252a280d6ac2))


### Bug Fixes

* **doc:** align TagEditor row with the '对 AI 隐藏' toggle ([bf0bd43](https://github.com/atbeta/notefast/commit/bf0bd43e47898cf3c0f73e4fdf2dcba9c735a612))

## [0.14.3](https://github.com/atbeta/notefast/compare/v0.14.2...v0.14.3) (2026-07-23)


### Bug Fixes

* read API response directly instead of extracting .body wrapper in ApiTokensPanel ([2e4a4bc](https://github.com/atbeta/notefast/commit/2e4a4bcb549a0e4c2de577899ea87b496e1c5c0c))

## [0.14.2](https://github.com/atbeta/notefast/compare/v0.14.1...v0.14.2) (2026-07-23)


### Bug Fixes

* remove duplicate /api/v1 prefix in ApiTokensPanel API calls ([1c66687](https://github.com/atbeta/notefast/commit/1c6668722276c0342c9296ab5c134a3bffae9811))

## [0.14.1](https://github.com/atbeta/notefast/compare/v0.14.0...v0.14.1) (2026-07-23)


### Bug Fixes

* tone down toast, remove inline edit button, merge tags sources ([38211e1](https://github.com/atbeta/notefast/commit/38211e12b193ef2bf517b332d4c375d4cef0ee1b))

## [0.14.0](https://github.com/atbeta/notefast/compare/v0.13.0...v0.14.0) (2026-07-23)


### Features

* **ai:** quantify retrieval latency and surface indexing progress ([a502592](https://github.com/atbeta/notefast/commit/a502592e13aecdb50046e41c6495995206dc0d0d))
* **api:** add in-memory sliding-window rate limit middleware ([91f74bc](https://github.com/atbeta/notefast/commit/91f74bc2fb92a445c274fad12df465ec86bb1302))
* **auth:** add multi-token api_tokens table with scopes and Settings UI ([4a4a043](https://github.com/atbeta/notefast/commit/4a4a0433da04ee065b5ae5bc511784feda21ead8))
* **db:** add content_hash column to blocks for SHA-256 content dedup ([93f78c7](https://github.com/atbeta/notefast/commit/93f78c7a96e07e5d2110eefb43dca9cd2f011a08))
* **db:** add entity_changes audit log with SQLite triggers ([468be1d](https://github.com/atbeta/notefast/commit/468be1d4c57b7cccf837749cc22529c0f129b3b9))
* **db:** soft-delete blocks with is_deleted/delete_id, restore API, and MCP tools ([2ce11ca](https://github.com/atbeta/notefast/commit/2ce11cac96127e0443531399a6a75508a236a90c))
* **observability:** add structured AppEvent schema, safeLog-emitter, and event context middleware ([2230e52](https://github.com/atbeta/notefast/commit/2230e52239a5fbd0ff8a7bf9f3f8bf569cec17e7))
* **ui:** add server-side pinned views with sidebar integration ([13684d3](https://github.com/atbeta/notefast/commit/13684d370c379eb2a3f2be28297a8f74a7baac95))
* **ux:** add first-run onboarding modal, AI graceful degradation, and status endpoint ([9bf94dc](https://github.com/atbeta/notefast/commit/9bf94dc40fed268e4a255365285e1cdfe95ef69a))


### Bug Fixes

* crypto.getRandomValues for tokens, unify migration registry ([614edfa](https://github.com/atbeta/notefast/commit/614edfa9b2ce75c5767ffa81e1965ccc0a70bd79))
* new doc tags, UTC timezone parsing, date format consistency, edit button placement ([6e4079e](https://github.com/atbeta/notefast/commit/6e4079e954477eea9d994260b528d06ae9255bff))


### Performance Improvements

* eliminate redundant /docs/tree fetch, memoize BlockNode ([b64f7b2](https://github.com/atbeta/notefast/commit/b64f7b28d0b4e785b2494a7bb68fad482bf7c32d))

## [0.13.0](https://github.com/atbeta/notefast/compare/v0.12.0...v0.13.0) (2026-07-22)


### Features

* **web:** render mermaid code fences as diagrams ([520cad2](https://github.com/atbeta/notefast/commit/520cad24d5fa43b3bd9b4a3f5d57b65412720180))


### Bug Fixes

* **autolink:** mark applied suggestions as accepted for inbox filters ([67db76b](https://github.com/atbeta/notefast/commit/67db76b67139594dce376ccb33866456dd3b0b86))
* maintainability hardening across server, web and core ([34555fb](https://github.com/atbeta/notefast/commit/34555fb7728f97eab50d6d4121d1781d6814e2f0))
* **ui:** restore primary button padding and CJK vertical centering ([6e20870](https://github.com/atbeta/notefast/commit/6e208708b6fc76125dc7c394f7bb29f6d8ae01bd))

## [0.12.0](https://github.com/atbeta/notefast/compare/v0.11.0...v0.12.0) (2026-07-22)


### Features

* **inbox:** document lifecycle status (note|inbox) + quick capture ([868d284](https://github.com/atbeta/notefast/commit/868d28490c4cd38497691b3b0c7b8e54230eb680))
* **tags,ui:** default AND tag filter with mode toggle and hide-from-AI UX ([b300521](https://github.com/atbeta/notefast/commit/b30052131bc4179e6989aa5cdb4021c379fdfcef))


### Bug Fixes

* theme toggle in command palette and missing Ctrl+Shift+D shortcut ([b8bae40](https://github.com/atbeta/notefast/commit/b8bae40313c66b84174bb3fb06195b2f6b95f9ca))
* **ui:** polish settings controls and replace native confirm dialogs ([9c2132c](https://github.com/atbeta/notefast/commit/9c2132cc921ab211a07cf0b8c9d43f4f82eb0798))

## [0.11.0](https://github.com/atbeta/notefast/compare/v0.10.0...v0.11.0) (2026-07-22)


### Features

* **chat:** streamed reasoning with collapsible ThinkBlock ([3424916](https://github.com/atbeta/notefast/commit/3424916626723e584f83f7db5ce13e0e5d4bb2ab))
* **tags,views,ai:** multi-tag filters, smart views, and hide-from-AI ([74014e8](https://github.com/atbeta/notefast/commit/74014e893a0d58cda8a4b06c384b047da607de46))

## [0.10.0](https://github.com/atbeta/notefast/compare/v0.9.0...v0.10.0) (2026-07-22)


### Features

* **backup:** in-app S3 snapshots, retire Litestream ([8886024](https://github.com/atbeta/notefast/commit/8886024d979627fade741093e39f9eebdc0eadd5))


### Bug Fixes

* **autolink,markdown,ui:** MCP detail crash, low-confidence inbox, parse/export round-trip ([71a2bef](https://github.com/atbeta/notefast/commit/71a2bef501ed5f8ea152a770321e19455cbc75e2))

## [0.9.0](https://github.com/atbeta/notefast/compare/v0.8.0...v0.9.0) (2026-07-22)


### Features

* **ai:** normalize vector storage with metadata, VectorStore, and sqlite-vec ([ec55cb0](https://github.com/atbeta/notefast/commit/ec55cb086668843f51c5a605c3fc8c85471f826e))
* **assets:** local AssetStore for images — content-addressed, deduped, auth-aware ([1ad9cd1](https://github.com/atbeta/notefast/commit/1ad9cd196058eda859cddab7c10c6819626b7f2d))
* **web:** full markdown reading experience — syntax highlighting, ol/task lists, rich inline ([e78b592](https://github.com/atbeta/notefast/commit/e78b592e2ac9a4ed7502ff099a5c459426b04364))


### Bug Fixes

* **mcp,chat:** JSON-RPC envelope error codes + semantic recall cosine floor ([aa686b1](https://github.com/atbeta/notefast/commit/aa686b1f3382518e23f45697205f0f8cf81be338))

## [0.8.0](https://github.com/atbeta/notefast/compare/v0.7.0...v0.8.0) (2026-07-21)


### Features

* **ai:** surface effective autoLink config — get_config output + startup log ([cdca723](https://github.com/atbeta/notefast/commit/cdca723d1e3e657a84799353c0c18fe80436c85f))
* **chat:** min_score citation filtering to cut RAG citation noise ([20b472c](https://github.com/atbeta/notefast/commit/20b472c8c7703cce4b0c803dd9597ff9b8aa4449))
* **mcp:** schema hardening, honest listChanged, and request logging ([18d736b](https://github.com/atbeta/notefast/commit/18d736bdfe44de789e5a769ae8e11c6f00f0bb36))
* **mcp:** unify tool error semantics — isError + structured error.code ([0c8c401](https://github.com/atbeta/notefast/commit/0c8c401e3b68208abd87a7c07c5f3d476577fe15))


### Bug Fixes

* **mcp:** create_doc FK failure on nested blocks (fenced code, sublists) ([cb30aaf](https://github.com/atbeta/notefast/commit/cb30aaf8c2ce6e037b8039b9aeeea6627d14dab2))
* render heading children (code blocks), save-to-reading flow, inbox bulk review, custom checkbox ([e07f222](https://github.com/atbeta/notefast/commit/e07f2224a4633a01a5d1fe9b4bf36e76985ea9ff))

## [0.7.0](https://github.com/atbeta/notefast/compare/v0.6.0...v0.7.0) (2026-07-21)


### Features

* **ai:** log config source at startup; add notefast_get_config MCP tool ([8763fa9](https://github.com/atbeta/notefast/commit/8763fa97564a90a34403771b1d4485c6d33ef41d))
* **auth:** persistent login with 7-day sliding expiry ([f59844a](https://github.com/atbeta/notefast/commit/f59844adac6e2a1c77c395c6828e60dd09bdf2c7))
* **auth:** split READ_TOKEN / WRITE_TOKEN with backward-compatible API_TOKEN ([4225023](https://github.com/atbeta/notefast/commit/4225023227069408118dcf5c23fc12415d139554))
* **autolink:** precision-first v3 — kill the noise flood at the source ([f7d125b](https://github.com/atbeta/notefast/commit/f7d125b99c8c73ea1a86cf5268db8863439843d0))
* **mcp:** multi-session transport pool + no-SID auto-init ([e972747](https://github.com/atbeta/notefast/commit/e97274735a45dbc95a2ebb43fddf82db379bd6c5))
* **ui:** sidebar settings icon + dynamic version from /api/v1/version ([a608917](https://github.com/atbeta/notefast/commit/a608917cc35959d9003c20cb63267e8291f2a55b))


### Bug Fixes

* **mcp:** address review findings — session cap, close() leak, auto-init scope ([06cf1e3](https://github.com/atbeta/notefast/commit/06cf1e3ca3ec01215bc9831ccad654a8d9e3f04f))
* **server:** log full stacks in chat/hybridSearch catches; fix FK bug in markdown import ([cc594a4](https://github.com/atbeta/notefast/commit/cc594a440d358c21915f212ea45a55f18f3fea2d))
* **server:** prefer APP_VERSION (docker tag) for /api/v1/version ([9bd1665](https://github.com/atbeta/notefast/commit/9bd1665be98537fda633312b3674e5131e88a8a6))

## [0.6.0](https://github.com/atbeta/notefast/compare/v0.5.0...v0.6.0) (2026-07-20)


### Features

* **core:** TagProvider abstraction with PropertiesTagProvider default ([43634bc](https://github.com/atbeta/notefast/commit/43634bcd7a03de494d61a39247afc9d5c4bb72da))
* **server:** tag API endpoints — list, filter, replace ([a61aa8d](https://github.com/atbeta/notefast/commit/a61aa8d2360642a6812c7cc6fdd295da7ebc9d5d))
* **web:** TagEditor in doc + TagFilter chip strip on home ([a2771ac](https://github.com/atbeta/notefast/commit/a2771acac08f74b728ce5672b2765eb7d2215cfa))


### Bug Fixes

* **web:** AIChatPanel fetch bypassed auth — route via fetchWithAuth ([d45293f](https://github.com/atbeta/notefast/commit/d45293fabb13cfb13fd3fe82b6cb1b6d46eb86d9))

## [0.5.0](https://github.com/atbeta/notefast/compare/v0.4.0...v0.5.0) (2026-07-20)


### Features

* **auth:** Web UI login prompt + server auth/mode endpoint ([6214ace](https://github.com/atbeta/notefast/commit/6214acef91f1c9cc158c9d6cc73303632b09b163))

## [0.4.0](https://github.com/atbeta/notefast/compare/v0.3.0...v0.4.0) (2026-07-20)


### Features

* **web:** flatten sidebar/main visual boundary + cap app at 1600px ([266b94c](https://github.com/atbeta/notefast/commit/266b94c37eea4e4ab1b75f57babffc4c6d39e934))


### Bug Fixes

* **docker:** drop node_modules from runner image to clear Trivy false-positive ([878e59e](https://github.com/atbeta/notefast/commit/878e59eb154cb11f1e24bf77dab9a6145763048f))
* **web:** unify page container padding so navigation no longer jitters ([a93c8e1](https://github.com/atbeta/notefast/commit/a93c8e16ffe9bf6633901663f38d116252705b06))

## [0.3.0](https://github.com/atbeta/notefast/compare/v0.2.0...v0.3.0) (2026-07-20)


### Features

* **web:** three-mode theme (light/dark/system) with FOUC-free init ([ea037a8](https://github.com/atbeta/notefast/commit/ea037a8fa30c86cdc0d8101e6c2e5929a72724b2))


### Bug Fixes

* add bun install in builder stage to fix workspace linking, upgrade actions to Node 24 ([330986c](https://github.com/atbeta/notefast/commit/330986c1159b6653ce06e9207a66fdf8048d199c))
* add bun install to builder stage for proper workspace linking ([801bf09](https://github.com/atbeta/notefast/commit/801bf094282b4e84538ed0ef8eb3f43fe4b1b803))
* **ai-chat:** include tool_calls in assistant message for OpenAI strict mode ([f91804f](https://github.com/atbeta/notefast/commit/f91804f8389ada5ea4e3b4957ad9366815fba594))
* **web:** prevent preset row from squeezing region badge in AI settings ([fc951d5](https://github.com/atbeta/notefast/commit/fc951d52edbd96f9bcbd66d9cac096d34b25de6f))

## [0.2.0](https://github.com/atbeta/notefast/compare/v0.1.0...v0.2.0) (2026-07-20)


### Features

* AI title/summary generation — lightweight LLM integration ([46f5788](https://github.com/atbeta/notefast/commit/46f57883df7d3a8b75d136fe21f817d2b8fbfdda))
* **ai-first:** Tier 1 backend — AutoLink persistence + dual-axis state + precise revert ([848aad3](https://github.com/atbeta/notefast/commit/848aad3b83ab686b13ecbb328d4508502fbbcf67))
* **ai:** AutoLink — suggest-first reverse links via plugin hook ([a96a3b4](https://github.com/atbeta/notefast/commit/a96a3b44519e13439dde7820f0e3195cf513d1f4))
* **ai:** preset shape tests, /diagnose endpoint, provider matrix docs ([ad50f4d](https://github.com/atbeta/notefast/commit/ad50f4dc2f657f79cd17ac31cb3cfab31e0db383))
* **ai:** RAG chat with hybrid search, reranker, and SSE streaming ([91115fa](https://github.com/atbeta/notefast/commit/91115fa66ae68d21e6c3843fc6ff4c7793d53128))
* **ai:** split chat/embedding providers with region grouping and 2026-07 default models ([ee7ff5f](https://github.com/atbeta/notefast/commit/ee7ff5feaaa5ce358f03d5b1c250e2b2b653aeb1))
* auto-generated API key + provider presets (openrouter/zhipu/qwen) ([4bb24d2](https://github.com/atbeta/notefast/commit/4bb24d2b09530f6822fcd9ac32a6caa69a26202a))
* **chat:** time-window search + agent loop with notefast_search_more tool ([7e32307](https://github.com/atbeta/notefast/commit/7e3230740c9e054a50b7dcfd0a10dbf71995cfbb))
* data sovereignty — sync adapter interface, S3 backup, Markdown auto-export ([0166a3a](https://github.com/atbeta/notefast/commit/0166a3adc55725d636ec27a4a57da934b94722d0))
* lifecycle hook system + semantic design tokens ([871946f](https://github.com/atbeta/notefast/commit/871946f763f4bedb5064d7c39268cfa9b9d83f69))
* **markdown:** table blocks, inline rendering, outline anchors, chat-aware layout ([bc72c7b](https://github.com/atbeta/notefast/commit/bc72c7b94970ed0a21b3827242aa0f536f43ee42))
* quick capture — allow empty title, auto-open editor on new doc ([7a08d41](https://github.com/atbeta/notefast/commit/7a08d418ee69dadf1d0f57888d996689d562fbe3))
* semantic search with pluggable embedding providers ([3287bc5](https://github.com/atbeta/notefast/commit/3287bc538fc4a05b346427adca2c31cafb3d7765))
* **server:** FTS 触发器 + MCP Streamable HTTP 传输 + 测试 ([f00a625](https://github.com/atbeta/notefast/commit/f00a6250ff145fe899ab1d0dae0c5acb0b8fc604))
* **server:** Notebook CRUD + FTS 自动回填 + API 集成测试 ([1c5f9e2](https://github.com/atbeta/notefast/commit/1c5f9e2db41810e069b55bda3333769d1484ce28))
* **sync:** LocalFS SyncAdapter — close the data-sovereignty loop ([8ad2e83](https://github.com/atbeta/notefast/commit/8ad2e833b48c8fae1411124d15c10fade551876b))
* **sync:** S3 SyncAdapter — full S3 / R2 / MinIO support ([ad4c7a4](https://github.com/atbeta/notefast/commit/ad4c7a410eb764c9f50e88755af6f1bcec815041))
* **sync:** WebDAV SyncAdapter — completes the data-sovereignty trilogy ([08421d0](https://github.com/atbeta/notefast/commit/08421d0760a1560ef2ae380bd5e118cd94c3e6b5))
* **web:** AI Inbox page + sidebar badge + autoApply policy UI ([c25a397](https://github.com/atbeta/notefast/commit/c25a397909ad98c1ade241c2ee52b322e2545f11))
* **web:** AI Settings page — full Web UI for AI configuration ([3a833e6](https://github.com/atbeta/notefast/commit/3a833e6b1a83db2913b8b1beb235fea88d74eee3))
* **web:** Backlinks 面板 + DocTree 目录 + Markdown 编辑 ([8f5ae4d](https://github.com/atbeta/notefast/commit/8f5ae4d4f73b681507a894f45fd8ddb1fe0a03ba))
* **web:** document CRUD UI + markdown editor upgrade ([b8760da](https://github.com/atbeta/notefast/commit/b8760dad44d78c1cb1fcacb2b09b493b7b003f17))
* **web:** icon-first editor toolbar + status bar; theme foundation; toolbar wrap ([53c57d1](https://github.com/atbeta/notefast/commit/53c57d1ab1e02f4c2df1d5a725471b237525ab0e))
* **web:** improve doc reading and editing UX ([1a404cf](https://github.com/atbeta/notefast/commit/1a404cf08324f30e8331f111c4d0e23e90dd2c3d))
* **web:** UI redesign with dark mode, sidebar, and new doc creation page ([114a4e0](https://github.com/atbeta/notefast/commit/114a4e06f24eb7e1d12e556056c20526d588dff0))
* **web:** unify action feedback with toast/button/action-button and restructure provider settings ([4a4747e](https://github.com/atbeta/notefast/commit/4a4747e028923631be4fd46a832368ddfb210fad))
* **web:** visual overhaul with hero orb, command palette, mobile drawer ([9cdcfc4](https://github.com/atbeta/notefast/commit/9cdcfc4b2d15c612982dd02538f31e1ae7b25e70))
* **web:** Wave 1 design system overhaul — paper + ink palette, serif reading, drop gradient-orb signals ([8a0ad21](https://github.com/atbeta/notefast/commit/8a0ad215fdc5d22f6cf5a8b2ec5d2807b743c49b))


### Bug Fixes

* **ai:** API key no longer destroyed by masked round-trip; expand provider matrix ([dedaa1b](https://github.com/atbeta/notefast/commit/dedaa1b08ead796f0b2b19b965c94e01825d765b))
* **auth:** use crypto.timingSafeEqual for token/password compare ([da5fab6](https://github.com/atbeta/notefast/commit/da5fab67b0fe745e5a6599655deee7baaa864c86))
* **doc:** eliminate flicker and layout jump when switching documents ([bd34390](https://github.com/atbeta/notefast/commit/bd3439038da24c2a25f50bd0a220c8548ee7d128))
* **hooks:** wire note lifecycle hooks + transactional multi-block writes ([3dab036](https://github.com/atbeta/notefast/commit/3dab036e4bb7e3648e2f900418fb425feabc9f9c))
* security hardening for v0.1.0 release ([b993492](https://github.com/atbeta/notefast/commit/b993492eaef6299adcef09cb596cbb7d7a767cf8))
