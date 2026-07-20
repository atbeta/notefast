# Changelog

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
