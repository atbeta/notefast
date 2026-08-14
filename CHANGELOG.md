# Changelog

## [0.66.0](https://github.com/atbeta/notefast/compare/v0.65.0...v0.66.0) (2026-08-14)


### Features

* **maintenance:** periodic purge of tombstones, change feed, vec generations ([86936cd](https://github.com/atbeta/notefast/commit/86936cd257b5f090bf16e56e4e025a790a810c7a))


### Bug Fixes

* harden routing & streaming; multi-writer sync protocol v2 ([76b80ec](https://github.com/atbeta/notefast/commit/76b80ec3e67c69175187b5a306a69f16a26d0a2d))


### Performance Improvements

* reduce hot-path scans and quadratic writes ([50c7f24](https://github.com/atbeta/notefast/commit/50c7f2469b7b085d532d348def3979b23778ae57))

## [0.65.0](https://github.com/atbeta/notefast/compare/v0.64.3...v0.65.0) (2026-08-13)


### Features

* **import:** support .docx conversion via mammoth in shared import UI ([62aa8ff](https://github.com/atbeta/notefast/commit/62aa8ff37444fd01da2df7e64aef1da17d5786f4))
* support importing .txt documents across web and native clients ([ec66d7e](https://github.com/atbeta/notefast/commit/ec66d7eb4879ed8f8408831ada8c0596fccad042))


### Bug Fixes

* **import:** accept one file at a time and keep images on the zip path ([ef07d18](https://github.com/atbeta/notefast/commit/ef07d182423ca4a55a82991e0e93ffb00b7df928))
* **sync:** apply each changes segment in one transaction ([e268e8f](https://github.com/atbeta/notefast/commit/e268e8f09c4bd11d74f344b7080362c0683c0a24))
* **web:** warn when importing md that references local images without files ([268da2b](https://github.com/atbeta/notefast/commit/268da2b318965b7e390ebc8966845e0526b443b3))

## [0.64.3](https://github.com/atbeta/notefast/compare/v0.64.2...v0.64.3) (2026-08-13)


### Bug Fixes

* **server:** limit FTS trigger to content changes so doc delete is fast ([c6eeeca](https://github.com/atbeta/notefast/commit/c6eeeca37ad52f6f2b0b5b89b00ab2d190ee6236))
* **tauri:** bold taskbar icon frames so small sizes stay legible ([d9e662d](https://github.com/atbeta/notefast/commit/d9e662d365f3453c475fd94fdeb201fc24861e6d))
* **tauri:** skip document list flash when opening md on cold start ([7f3ba24](https://github.com/atbeta/notefast/commit/7f3ba243ce48e032e625bde297d46530fb4ceec4))
* **web:** keep tag filter icon on same line as chips when wrapping ([4c6c0ef](https://github.com/atbeta/notefast/commit/4c6c0efb47a260676774e70c76f57ea519b93375))
* **web:** lightbox click-to-close and resources header polish ([dc4a857](https://github.com/atbeta/notefast/commit/dc4a85767dd1bfb6010ab59f6db1214ea2389b00))

## [0.64.2](https://github.com/atbeta/notefast/compare/v0.64.1...v0.64.2) (2026-08-12)


### Bug Fixes

* **i18n:** correct Markdown archive helpTip - frontmatter carries tags ([c40ac22](https://github.com/atbeta/notefast/commit/c40ac22648ddf2077ec88689d678a9a5b710f24b))
* **server,web:** entity rebuild progress frozen + lost across pages ([aca3f79](https://github.com/atbeta/notefast/commit/aca3f79ad51435d757e3a4302051458a8564ac86))
* **server:** avoid double-counting entity rebuild errors ([5d2f395](https://github.com/atbeta/notefast/commit/5d2f395ab544043bb85532b1ee2f99fb4a9f67de))
* **tauri:** correct icon generator RGB averaging ([a02d1f9](https://github.com/atbeta/notefast/commit/a02d1f94a7068c0cf5f2784d6c58a1e74525f8f0))
* **tauri:** regenerate icons from favicon geometry with AA corners ([1a364c3](https://github.com/atbeta/notefast/commit/1a364c32c5ab45276954be45f8c276e0c919b505))
* **web:** citation sources numbering must match in-text [n] refs ([2ebfc53](https://github.com/atbeta/notefast/commit/2ebfc539feb7c32cc2461b43ccd444d7a8faabfa))
* **web:** shorten Windows titlebar close tooltip to avoid wrap ([673c610](https://github.com/atbeta/notefast/commit/673c610a3d854fbdc8bbc941c78f60c27aa1b6ce))

## [0.64.1](https://github.com/atbeta/notefast/compare/v0.64.0...v0.64.1) (2026-08-12)


### Bug Fixes

* **server:** entity rebuild was slow AND empty - bypass rate limit + batch extraction ([e591d9a](https://github.com/atbeta/notefast/commit/e591d9a3e17af2cfe3624905c9ad548c0adcbda4))


### Performance Improvements

* **server:** batch extraction slices by char budget, not block count ([05a818b](https://github.com/atbeta/notefast/commit/05a818be13a5a456f8adf659acc34be07f45dbaf))

## [0.64.0](https://github.com/atbeta/notefast/compare/v0.63.1...v0.64.0) (2026-08-11)


### Features

* **web,clients:** add About page with manual updates and unify app icon ([d0f4d54](https://github.com/atbeta/notefast/commit/d0f4d54a8bf045df4cbec69f42123e9771e1d627))


### Bug Fixes

* **sync:** stop treating ai_exclude docs as tombstones ([694dc8f](https://github.com/atbeta/notefast/commit/694dc8f4f8115e71cb2473eb80f4744792a3a173))

## [0.63.1](https://github.com/atbeta/notefast/compare/v0.63.0...v0.63.1) (2026-08-11)


### Bug Fixes

* **macos:** align shell chrome density with web and drop NavStrip ([70c177f](https://github.com/atbeta/notefast/commit/70c177fb3e428bc6bb39d57ed6ac37fb70271fb4))

## [0.63.0](https://github.com/atbeta/notefast/compare/v0.62.1...v0.63.0) (2026-08-11)


### Features

* **web:** exit demo mode with Escape ([1edbad6](https://github.com/atbeta/notefast/commit/1edbad64ac41c332529495e83b45814afd8d0c90))


### Bug Fixes

* **web:** compact doc zoom control and restore zoom on demo exit ([ecfab47](https://github.com/atbeta/notefast/commit/ecfab47af2bfd87899c8a74c03674d95a46f78df))
* **web:** disable input history with nonstandard autocomplete token ([15b7123](https://github.com/atbeta/notefast/commit/15b712320ef7f9a35da50da58fe6c5e0ec804718))
* **web:** drop redundant AI index refresh and feedback the status button ([99a925d](https://github.com/atbeta/notefast/commit/99a925df0d09ed399764fa2dbaf269c79e9a7d80))
* **web:** hide image-host upload UI when not configured ([416b805](https://github.com/atbeta/notefast/commit/416b805dea1a6384f3776095cf4721272dac3ff2))
* **web:** migrate chrome hover tips from title to Tooltip ([baaba72](https://github.com/atbeta/notefast/commit/baaba72f52d763295ce26c409f7e6ae8ec239072))
* **web:** move app brand to TitleBar and drop sidebar brand row ([89604c6](https://github.com/atbeta/notefast/commit/89604c6ad47782c3e7757b263a6150da437acfa2))

## [0.62.1](https://github.com/atbeta/notefast/compare/v0.62.0...v0.62.1) (2026-08-11)


### Bug Fixes

* **server,web:** ingest relative-path images on open and web import ([a789596](https://github.com/atbeta/notefast/commit/a78959651729099839f4448f5ffa49fc90eb3a73))

## [0.62.0](https://github.com/atbeta/notefast/compare/v0.61.1...v0.62.0) (2026-08-11)


### Features

* **server:** ingest same-dir images when opening/importing markdown ([388c32d](https://github.com/atbeta/notefast/commit/388c32d939fe91a1ec08ea02e16df419cdecaf3e))
* **web:** one-click cleanup of unreferenced images ([83ba179](https://github.com/atbeta/notefast/commit/83ba1796ac13bf8439cc4423a6d29950112f3374))
* **web:** two-level reading column width (46rem / 64rem) ([0909d0e](https://github.com/atbeta/notefast/commit/0909d0ee90c822201bfa96c2fb6914998a6721f5))
* **web:** zoom available in read mode; hide title bar in demo ([e705270](https://github.com/atbeta/notefast/commit/e705270fd0b1e25fc21a2e3b3a9fcc8f3f8f984d))

## [0.61.1](https://github.com/atbeta/notefast/compare/v0.61.0...v0.61.1) (2026-08-11)


### Bug Fixes

* **web:** doc header layout — centered title, actions on both sides ([751ca6e](https://github.com/atbeta/notefast/commit/751ca6e72aeea71ecda67223a901ad4c615e4c04))

## [0.61.0](https://github.com/atbeta/notefast/compare/v0.60.0...v0.61.0) (2026-08-11)


### Features

* **web:** obsidian-style doc navigation + demo button to header ([dddc1c3](https://github.com/atbeta/notefast/commit/dddc1c36bf54bd508a082f7819e5a662fdd195a9))


### Bug Fixes

* **web:** outline click highlights target immediately; tolerate subpixel scroll ([e687cf2](https://github.com/atbeta/notefast/commit/e687cf28f1bc1d6f8107eacd9f5c7a1f7df1931c))

## [0.60.0](https://github.com/atbeta/notefast/compare/v0.59.0...v0.60.0) (2026-08-11)


### Features

* **web:** demo mode (whole-doc zoom) replaces 4-step font size; rail 288/400 ([b0a96b1](https://github.com/atbeta/notefast/commit/b0a96b1ddcc55fe057f341508984a9385bba3f0f))

## [0.59.0](https://github.com/atbeta/notefast/compare/v0.58.2...v0.59.0) (2026-08-11)


### Features

* **web:** click any doc image to view full size in a lightbox ([e8600df](https://github.com/atbeta/notefast/commit/e8600df325c4bf45bf1cd38aaf05053d9e613869))
* **web:** doc font size control (4 sizes) for demo + accessibility ([ca87c33](https://github.com/atbeta/notefast/commit/ca87c3382a1f3ce9a56b27df64e957b750e7df15))
* **web:** resources page — remote URL hover, per-image upload, batch upload moved from settings ([ac14936](https://github.com/atbeta/notefast/commit/ac1493662cfe9878684db86d727425773a3028f6))
* **web:** side panel width toggle (400/600px, aligns with AI chat panel) ([7d2e5d1](https://github.com/atbeta/notefast/commit/7d2e5d1137b16fa10dc8d70d9d2e5e35d5073bf0))


### Bug Fixes

* **server:** sync image upload config to store layer on save ([85cf354](https://github.com/atbeta/notefast/commit/85cf3542e0663779e841d3189a4a0a1eb37ebe6a))
* **web:** outline active-heading highlight now follows scroll reliably ([39e6c2a](https://github.com/atbeta/notefast/commit/39e6c2a0c5111993c4ec0495e7b174fd4629a151))

## [0.58.2](https://github.com/atbeta/notefast/compare/v0.58.1...v0.58.2) (2026-08-10)


### Bug Fixes

* **macos:** restore a single populated window on Dock reopen ([bdd6df0](https://github.com/atbeta/notefast/commit/bdd6df095107d52809ec475748b533c32c0bad66))

## [0.58.1](https://github.com/atbeta/notefast/compare/v0.58.0...v0.58.1) (2026-08-10)


### Bug Fixes

* **tauri:** hold splash longer and align startup backgrounds ([55bc70a](https://github.com/atbeta/notefast/commit/55bc70a3f620d76468bf484790b2ea2d609f83a2))
* **web:** cache AI capabilities snapshot to stop React [#185](https://github.com/atbeta/notefast/issues/185) ([6619941](https://github.com/atbeta/notefast/commit/66199413b7d073eeace4fb08dfd8bba2653efb2f))

## [0.58.0](https://github.com/atbeta/notefast/compare/v0.57.0...v0.58.0) (2026-08-10)


### Features

* **resources:** preview images fullscreen and delete unused assets ([1b96f7a](https://github.com/atbeta/notefast/commit/1b96f7a62d3f8a556d81dfa29fdd90512c91dc22))
* **web:** replace sidebar recent-updated list with recently viewed ([074f71b](https://github.com/atbeta/notefast/commit/074f71b88226d922c822f34a58699f262229ac3d))


### Bug Fixes

* **ci:** ship complete Windows portable zip with engine on release ([69abb56](https://github.com/atbeta/notefast/commit/69abb560192b5536a81826c910ea95c8c2fc2d55))
* **web:** degrade AI entry points gracefully when Chat is unset ([bde0425](https://github.com/atbeta/notefast/commit/bde042515eb4b46696669a83352d5be7e9c892e6))
* **web:** drop focus outline on command palette search input ([0aff627](https://github.com/atbeta/notefast/commit/0aff6275244a94739ba3822d73b25e7a192f3b54))
* **web:** stop per-line borders leaking into fenced code blocks ([37619fd](https://github.com/atbeta/notefast/commit/37619fd0defc18d57d68a992c707052ee7e7c340))

## [0.57.0](https://github.com/atbeta/notefast/compare/v0.56.0...v0.57.0) (2026-08-10)


### Features

* **tauri:** windows portable zip alongside NSIS installer ([96f1d56](https://github.com/atbeta/notefast/commit/96f1d565fdd22c3deede6db7cabf654acf38cf69))


### Bug Fixes

* **ci:** cd to workspace first, then relative path ([80f9e16](https://github.com/atbeta/notefast/commit/80f9e16c2ab5b2d33a3ad9dd038cc93d1c19ca05))
* **ci:** portable artifact path points to target/release (was bundle/app) ([8a3019b](https://github.com/atbeta/notefast/commit/8a3019bde6a997c41719b17ec7f9bbb166f4996d))
* **ci:** portable zip reads raw exe from target/release, not bundle/app ([edbbcf0](https://github.com/atbeta/notefast/commit/edbbcf01f09e3600449c65d4d24a77e07f7d5792))
* **ci:** portable zip step uses cd instead of working-directory ([7f8219d](https://github.com/atbeta/notefast/commit/7f8219d2346b1c62ee5fd0368b4a786899b134cc))
* **ci:** separate portable zip build from release upload; rename exe ([c13aec0](https://github.com/atbeta/notefast/commit/c13aec030a58300bea603e8970078b275e75495c))
* **ci:** valid YAML — use \${{ github.token }} instead of *** placeholder ([b95cb6d](https://github.com/atbeta/notefast/commit/b95cb6d96fd1d3a4031c988c962ee2b2e549ff4e))

## [0.56.0](https://github.com/atbeta/notefast/compare/v0.55.0...v0.56.0) (2026-08-09)


### Features

* **apple:** harden macOS shell — navigation policy, downloads, crash recovery, engine logging ([ad4a9b0](https://github.com/atbeta/notefast/commit/ad4a9b0782c9b0e6cdd16ad81afd4ab94f32bfbb))
* **apple:** menu bar status item + keep-running on window close ([00f7735](https://github.com/atbeta/notefast/commit/00f77351b48d5c1ada8424b9b337930f5fa213e0))
* **apple:** native back/forward buttons in top-left title strip ([bd24a8f](https://github.com/atbeta/notefast/commit/bd24a8f12c923341ceee2a7c2947a92d00c9dad3))
* **apple:** update check, blocking version gate, search deep link, system notifications ([a6ee5c8](https://github.com/atbeta/notefast/commit/a6ee5c8249b5f5253dbd0a852e6d11af35e1e060))


### Bug Fixes

* **apple:** reuse main window instead of spawning duplicates ([c22e876](https://github.com/atbeta/notefast/commit/c22e876700ed1300c3b8dbeb9ec760708a25a918))
* **tauri:** avoid dark flash on light Windows startup ([d828985](https://github.com/atbeta/notefast/commit/d828985cf0d09a7b1b0f0e84ae8838e6348c878c))

## [0.55.0](https://github.com/atbeta/notefast/compare/v0.54.0...v0.55.0) (2026-08-08)


### Features

* add related-docs rail tab with fast lexical neighbors ([6065cca](https://github.com/atbeta/notefast/commit/6065cca8ae12293fd221fde24cff4ded9dd2c3c8))
* project doc metadata into markdown frontmatter on export ([76647c6](https://github.com/atbeta/notefast/commit/76647c6cc4b6db1c34c9b8fa800e7e19277662ea))
* resources library, sidebar IA, and insert from assets ([761c0ae](https://github.com/atbeta/notefast/commit/761c0ae87ca67ee2b514eda09d5ee451f1e7dc45))


### Bug Fixes

* **core:** drop useless regex escape in frontmatter YAML check ([c9f909a](https://github.com/atbeta/notefast/commit/c9f909abdc330c123c5064e511f5efae9504eeba))
* **web:** drop sidebar search placeholder and widen doc rail ([8d067a3](https://github.com/atbeta/notefast/commit/8d067a3f62d35de0df63322a444949c92c8e210b))

## [0.54.0](https://github.com/atbeta/notefast/compare/v0.53.0...v0.54.0) (2026-08-08)


### Features

* **server:** LLM query understanding for chat retrieval ([1d2f04e](https://github.com/atbeta/notefast/commit/1d2f04e8ac576c61dcff8d2261df4701e8823166))
* **web:** ux polish — confirm dialog a11y, settings routing, sidebar/rail collapse, focus styles ([ec199a6](https://github.com/atbeta/notefast/commit/ec199a6f23261e783170bd2f3716395f6ac30952))


### Bug Fixes

* **web:** image uploader sent literal 'Bearer ***' since XHR refactor ([4c561ce](https://github.com/atbeta/notefast/commit/4c561ce3a4276fc911d29769cab4a9e3a80021eb))
* **web:** settings deep links and sync capsule rail offset ([00dfc91](https://github.com/atbeta/notefast/commit/00dfc91aa2d01b413f0b0665168aa97e0034d772))

## [0.53.0](https://github.com/atbeta/notefast/compare/v0.52.0...v0.53.0) (2026-08-08)


### Features

* **doc:** scroll-linked active heading in outline ([04c163c](https://github.com/atbeta/notefast/commit/04c163c02db21adf18aa5bf908210f5bdda2727c))
* **editor:** drag-and-drop image overlay with 'drop to upload' hint ([95e2bdb](https://github.com/atbeta/notefast/commit/95e2bdb9cab60d04b3a39c3b2c85e147f0a7140a))
* **editor:** upload progress ring + percentage in toolbar ([e8d8ca0](https://github.com/atbeta/notefast/commit/e8d8ca089bdec1ae3a9bf5f5a0641308f4ef88c7))
* **ui:** hide DocActionsMenu trigger until row hover ([1252e88](https://github.com/atbeta/notefast/commit/1252e882a64034a86e0231f4642d4282a49fc129))
* **ui:** press feedback on Button + IconBtn primitives ([3de47c8](https://github.com/atbeta/notefast/commit/3de47c89ee870348bb9735a6c282dc7490b2092a))


### Bug Fixes

* **a11y:** global focus-visible ring on inputs as a11y safety net ([42b8a0d](https://github.com/atbeta/notefast/commit/42b8a0d08d7dde8cd8f4a073d030fbb60f09b037))

## [0.52.0](https://github.com/atbeta/notefast/compare/v0.51.0...v0.52.0) (2026-08-08)


### Features

* **server,web:** client error telemetry to backend ([1f3af40](https://github.com/atbeta/notefast/commit/1f3af4006b4279961df6af032cfb5ac244fc8465))
* **web:** lazy-load secondary routes (entities / graph / settings / share) ([48512c0](https://github.com/atbeta/notefast/commit/48512c00a6f39cdc85c7c43d4e98e8290fe0c764))
* **web:** route-level error boundary isolates crashes ([f0d16bf](https://github.com/atbeta/notefast/commit/f0d16bf23ab99c013162b5d25e40f7aa8f022b2d))
* **web:** server health probe + offline banner ([3351b99](https://github.com/atbeta/notefast/commit/3351b9938b053a7328dccbd9439aa5354476fca8))
* **web:** shared useAiCapabilities + toolbar hint when AI unconfigured ([4f5137f](https://github.com/atbeta/notefast/commit/4f5137fa8c8af1eda51074d45d5d864280e5438f))
* **web:** useApiMutation hook with network-error retry ([5f4e080](https://github.com/atbeta/notefast/commit/5f4e0808ee5ce2dbe8c9cafb174b1ceb08eae6d6))


### Bug Fixes

* **ci:** lighthouse CLI v13 output-path syntax ([49a8e81](https://github.com/atbeta/notefast/commit/49a8e814e4e1448cfdb4ffe5df5844e45459d63c))
* **web:** IME composition guard for shortcuts + selection bubble ([7df2fb5](https://github.com/atbeta/notefast/commit/7df2fb5b6bf9618f2a8bdf8706e5cc241fa79b7f))

## [0.51.0](https://github.com/atbeta/notefast/compare/v0.50.0...v0.51.0) (2026-08-08)


### Features

* **web:** custom context menu for reading and preview doc areas ([f3d166d](https://github.com/atbeta/notefast/commit/f3d166d1b3abc25821b790665615a40cb176d445))
* **web:** drop capture panel and bookmarklet generator ([9077e62](https://github.com/atbeta/notefast/commit/9077e62356dba4f8432678d801ad64aa61170fc4))


### Bug Fixes

* **web:** drive palette mask opacity and blur in single rAF ([c0bad24](https://github.com/atbeta/notefast/commit/c0bad245daa5dcaba0f17e3c369e8deb6c5c323b))

## [0.50.0](https://github.com/atbeta/notefast/compare/v0.49.0...v0.50.0) (2026-08-07)


### Features

* **entities:** merge substring duplicate suggestions directly instead of writing term-dict ([38bd3fa](https://github.com/atbeta/notefast/commit/38bd3fa65fea2f2cdc8059641e7928e9b25265cb))
* **server:** capture channel readiness — CORS '*', write-scope enforcement, optional notebook, tag normalize ([f4734f1](https://github.com/atbeta/notefast/commit/f4734f101ba7edf17e939ef56bd1172f78e26192))
* **server:** prune entity_changes after sync compaction ([35d6688](https://github.com/atbeta/notefast/commit/35d6688dde2e65f499ea8ca67d5756fd7af54651))
* **web:** capture settings panel with bookmarklet generator ([6039482](https://github.com/atbeta/notefast/commit/60394822b7c2a807cccdae8d233567cebe7eaff2))
* **web:** editor math preview and selection bubble with streaming refine ([fff994d](https://github.com/atbeta/notefast/commit/fff994d64f5359e167725055030b7c9785e6cb90))
* **web:** render LaTeX math in AI chat messages ([3510549](https://github.com/atbeta/notefast/commit/351054947e364773d7d14e1be6817a23db661cd9))


### Bug Fixes

* **server:** strip inline think blocks from /ai/write stream ([8277158](https://github.com/atbeta/notefast/commit/8277158128bdf1f6b41e57cccc37f13cf00b5a6a))
* **server:** warn loudly when unauthenticated mode combines with CORS '*' ([7d7c62b](https://github.com/atbeta/notefast/commit/7d7c62bbcb5a02f6472d92aefe0e5af53a4424d2))
* **web:** fall back to selection-start anchor and prefer the higher end for multi-line selections ([6f9f750](https://github.com/atbeta/notefast/commit/6f9f7500d04c793bd381adea5b45edb91d7cde3f))
* **web:** show actual merge direction in entity suggestion rows ([fc4e4c1](https://github.com/atbeta/notefast/commit/fc4e4c19f05492de4615c77cc57dffa3de629c74))

## [0.49.0](https://github.com/atbeta/notefast/compare/v0.48.0...v0.49.0) (2026-08-07)


### Features

* **web:** effective entity description with dictionary priority ([27e2262](https://github.com/atbeta/notefast/commit/27e2262d14fa16fa1a84aba5676e0c29848abf80))
* **web:** MCP config example supports OpenCode and Claude/Cursor ([2f4ed30](https://github.com/atbeta/notefast/commit/2f4ed301a9eaef319b24c4a12751199b9790847e))
* **web:** structured entity dictionary editor with import/export ([d406917](https://github.com/atbeta/notefast/commit/d40691782863c10ee84f723236d68a99ba6c2c00))


### Bug Fixes

* **web:** CJK fallbacks for monospace stacks (tags/entities/code) ([267ca38](https://github.com/atbeta/notefast/commit/267ca38a24c30067fb099d567b0397822f3433c0))
* **web:** clarify account security section without shell detection ([c4702e4](https://github.com/atbeta/notefast/commit/c4702e4ce110eff7a23602ed3f5ea43a085383bf))
* **web:** Ctrl+J toggle stale closure breaks consecutive use ([2806ca3](https://github.com/atbeta/notefast/commit/2806ca37f02d54df070659908b8c3d0742f75d93))
* **web:** smooth graph hover dimming transitions ([f7fdc87](https://github.com/atbeta/notefast/commit/f7fdc87553f96528e7835ceade278bd0ff722716))

## [0.48.0](https://github.com/atbeta/notefast/compare/v0.47.1...v0.48.0) (2026-08-07)


### Features

* **web:** tag picker popover for reusing existing tags ([c5aa3ce](https://github.com/atbeta/notefast/commit/c5aa3cec1d2a9c22e3ae98d9e0201019d71b0294))


### Bug Fixes

* **web:** drive palette backdrop blur with rAF for smooth fade ([2d4df7e](https://github.com/atbeta/notefast/commit/2d4df7e6b789f229cd708d08aff0a8e6469ba24d))

## [0.47.1](https://github.com/atbeta/notefast/compare/v0.47.0...v0.47.1) (2026-08-07)


### Bug Fixes

* **clients:** drop unsupported fileAssociations icon on tauri ([223f374](https://github.com/atbeta/notefast/commit/223f374c92b5e9a88416af7646535880b550a74a))

## [0.47.0](https://github.com/atbeta/notefast/compare/v0.46.0...v0.47.0) (2026-08-07)


### Features

* **clients:** dedicated markdown document icon for .md association ([0136915](https://github.com/atbeta/notefast/commit/0136915735c4cd49506f8d16c8b4747540c45ff3))
* **trash:** permanent delete and empty trash ([ff8177b](https://github.com/atbeta/notefast/commit/ff8177b572172f1cc626556910ee92cc918b5cf3))
* **web:** honest local-link hint in share dialog ([db11513](https://github.com/atbeta/notefast/commit/db11513a315ea5fa466079ed5ccc7025953aae9c))
* **web:** pinned views sorted by name for predictable order ([ad0a8ec](https://github.com/atbeta/notefast/commit/ad0a8ec3ecc360811ae222581e7d719170ee7ed8))
* **web:** show document creation time in list and doc header ([f921be4](https://github.com/atbeta/notefast/commit/f921be4c892995fd3904e5d5f763cbaed1ceb191))
* **web:** sidebar count badges for queues and audit views ([2d44249](https://github.com/atbeta/notefast/commit/2d44249ad2468b0516a1b7de0323815fcce6b722))
* **web:** surface built-in MCP in settings panel ([9e676d0](https://github.com/atbeta/notefast/commit/9e676d0b0797da6b1b46d85b44ac10be9c9a7dc2))


### Bug Fixes

* **server:** tag and ai-exclude edits no longer bump updated_at ([836e175](https://github.com/atbeta/notefast/commit/836e175b84eb960a4b7b91d3ffa5c86de5efd010))
* **sync:** archive export save dialog and honest import feedback ([9b9f907](https://github.com/atbeta/notefast/commit/9b9f90729c72e45e060132ff5c077af8bc84b0d3))
* **web:** code block body is a flush solid block under the header ([6324e25](https://github.com/atbeta/notefast/commit/6324e250f70fb41a71d5bef052721591a224c3de))
* **web:** command palette backdrop blur animates with fade-in ([a43f54d](https://github.com/atbeta/notefast/commit/a43f54d3533ec7d0c12d747993341e5ae916845a))

## [0.46.0](https://github.com/atbeta/notefast/compare/v0.45.0...v0.46.0) (2026-08-07)


### Features

* add doc trash with restore and MCP delete_doc tool ([0a8f4a4](https://github.com/atbeta/notefast/commit/0a8f4a41903c4f283cec3fb2fc7db1e256f1ad75))
* **import:** dedupe file-open imports via source path upsert ([2e63913](https://github.com/atbeta/notefast/commit/2e63913b9a265f6109641c6976ac4580ba894384))
* **mcp:** add document share tools (share_doc / get_share / unshare_doc) ([df3be33](https://github.com/atbeta/notefast/commit/df3be339a0484d9324f399b76db67b6eb5627a45))
* **web:** render LaTeX math in reading view ([675d7ab](https://github.com/atbeta/notefast/commit/675d7ab3166e6b840993115628554d3b636526df))


### Bug Fixes

* **ai:** surface doc_id/block_id in chat context, validate list_docs status ([104d216](https://github.com/atbeta/notefast/commit/104d216b64cabc85f71a21e579188c84dd3d3156))
* **markdown:** preserve list markers and blank lines between blocks ([47ed3a4](https://github.com/atbeta/notefast/commit/47ed3a42a7a4c6c03b77d400ebe3931b51de2866))

## [0.45.0](https://github.com/atbeta/notefast/compare/v0.44.0...v0.45.0) (2026-08-05)


### Features

* **graph:** auto-merge spelling variants, adopt substring candidates via dictionary ([c797964](https://github.com/atbeta/notefast/commit/c797964a4b0ef57ebc97a094c1332b38dd730225))
* **macos:** hidden title bar, web-drawn top area follows theme ([fd50562](https://github.com/atbeta/notefast/commit/fd505625b582d3af24bb24b4beeb8032f0bc001e))
* **macos:** open-to-import for Markdown files + SSE watchdog ([46631ad](https://github.com/atbeta/notefast/commit/46631ad6f15f084770dc9a3a4ec63081d1883a95))
* **search:** add user-declared entity term-dictionary (term-dict) ([13c6ef6](https://github.com/atbeta/notefast/commit/13c6ef60335802196f47eaf36a28d9e1e9b448f4))
* **search:** freeze CJK prefix strip list, drop noun-head verbs ([f25ed2c](https://github.com/atbeta/notefast/commit/f25ed2c302fbbd1fbdc36254b5404360ede20080))
* **search:** strip CJK trailing question suffixes and normalize full-width forms ([933b1b1](https://github.com/atbeta/notefast/commit/933b1b13943177978a7c9635382aaf19452cfcd1))
* **tauri:** bilingual NSIS installer (English + SimpChinese) ([0f144bc](https://github.com/atbeta/notefast/commit/0f144bc1fd89efedc689da59dea30a40ff52dd47))
* **tauri:** open-to-import for Markdown files on Windows ([fda9cde](https://github.com/atbeta/notefast/commit/fda9cde2b1e454d625b61ac98e2b7469e14b6cb0))
* **web:** subtle transition polish + fix preferences API path ([10613b5](https://github.com/atbeta/notefast/commit/10613b50473e7e158a1f8ef601c5c30f3ba82ac7))


### Bug Fixes

* **web:** skip leave-overlay for same-route navigations ([0b85ebc](https://github.com/atbeta/notefast/commit/0b85ebcbcb221e9091e574ca893db35301a0ae3d))

## [0.44.0](https://github.com/atbeta/notefast/compare/v0.43.0...v0.44.0) (2026-08-05)


### Features

* **search:** strip CJK question prefixes so '什么是XXX' hits 'XXX是什么' ([221135c](https://github.com/atbeta/notefast/commit/221135c75bd0a723c8c12020e9c590565f87f1d0))
* **tauri:** polish the startup splash screen ([8693b5f](https://github.com/atbeta/notefast/commit/8693b5f67f9714a14831e7685e7c8e30c1d2f95a))
* **web:** add export button to document top bar ([4cc6079](https://github.com/atbeta/notefast/commit/4cc607910e05deb81a643fae66c1d7c1b1bf1193))
* **web:** per-image sync badge with single-image upload ([0db970c](https://github.com/atbeta/notefast/commit/0db970cabec8581e45b573796fd3993bce30cadd))


### Bug Fixes

* **web:** CRLF documents crashed the editor (Selection outside of document) ([7b00076](https://github.com/atbeta/notefast/commit/7b00076adc5db6c5fc72ca17f566b7370dd051a1))

## [0.43.0](https://github.com/atbeta/notefast/compare/v0.42.1...v0.43.0) (2026-08-05)


### Features

* **ai:** show incremental indexing job progress in semantic index panel ([abc0fcd](https://github.com/atbeta/notefast/commit/abc0fcd9187baddcc603df9f77a3b1a5a9ef1a50))
* **web:** global error boundary — component errors show details instead of white screen ([f995c2e](https://github.com/atbeta/notefast/commit/f995c2ea6b60cf0cabc681b20d5a70ee2adf8e00))

## [0.42.1](https://github.com/atbeta/notefast/compare/v0.42.0...v0.42.1) (2026-08-05)


### Bug Fixes

* **tauri:** use real fs permission id (fs:write-files); surface export error details ([f32c831](https://github.com/atbeta/notefast/commit/f32c831dc991f40688faddbdbbeb4e49ab3ce0fc))

## [0.42.0](https://github.com/atbeta/notefast/compare/v0.41.0...v0.42.0) (2026-08-05)


### Features

* **assets:** use image-host external links in export and share ([3a6f10b](https://github.com/atbeta/notefast/commit/3a6f10bec078cf51f4f5090dbfc178fabacffdfa))
* **web:** disable input history autofill globally (password exempt) ([4a62f0d](https://github.com/atbeta/notefast/commit/4a62f0d4b499a1cf9560408d3ec498c227790128))


### Bug Fixes

* **assets:** last-upload-error is per latest attempt, dismissible in UI ([c30f65d](https://github.com/atbeta/notefast/commit/c30f65de3422a5fde89b5feeac5c0175ec03da17))
* **tauri:** grant dialog/fs permissions for export save dialog; restore local image serving ([62fd6cc](https://github.com/atbeta/notefast/commit/62fd6cc0b9dbfa0dcefda989932732d5ca7ea92d))

## [0.41.0](https://github.com/atbeta/notefast/compare/v0.40.1...v0.41.0) (2026-08-05)


### Features

* **tauri:** export via save dialog instead of silent Downloads download ([c691f2c](https://github.com/atbeta/notefast/commit/c691f2ccba9f87865056878e8ad15438d47c239b))


### Bug Fixes

* **assets:** upload with proper file extension; batch backfill for existing images ([a19ede2](https://github.com/atbeta/notefast/commit/a19ede22b52e75c8d3dc062bc20b02a80bb94f2b))

## [0.40.1](https://github.com/atbeta/notefast/compare/v0.40.0...v0.40.1) (2026-08-05)


### Bug Fixes

* **assets:** tolerate full command strings, surface upload errors ([bf2b944](https://github.com/atbeta/notefast/commit/bf2b944a1e2cfd15818d59416ae8f1c8d20a695d))
* **tauri:** enable HTML5 drag-and-drop in the shell window ([88fd30b](https://github.com/atbeta/notefast/commit/88fd30bfdcc4bcd489621bc4500f80faa537f0c2))

## [0.40.0](https://github.com/atbeta/notefast/compare/v0.39.1...v0.40.0) (2026-08-05)


### Features

* **assets:** image hosting via Typora-style command contract ([bcde112](https://github.com/atbeta/notefast/commit/bcde1127c720831d4d476ed3a197ebe33d9d2b43))
* **web:** support zip import from the new-doc import tab ([20bae42](https://github.com/atbeta/notefast/commit/20bae42999267bd7c249a122c043b9ccbe3051fa))

## [0.39.1](https://github.com/atbeta/notefast/compare/v0.39.0...v0.39.1) (2026-08-05)


### Bug Fixes

* **tauri:** use tauri::webview::Color for set_background_color ([27a6820](https://github.com/atbeta/notefast/commit/27a6820cf120a0addc8623174aa4b334b661819e))

## [0.39.0](https://github.com/atbeta/notefast/compare/v0.38.0...v0.39.0) (2026-08-05)


### Features

* **ai:** add local Ollama preset (OpenAI-compatible /v1 endpoint) ([15b3794](https://github.com/atbeta/notefast/commit/15b3794a0dcf55726baaff93fcea4b557ecb822a))
* **ai:** drop write-confirmation cards, agent writes directly ([dd7f623](https://github.com/atbeta/notefast/commit/dd7f6236853a6ab16214a12ead66e8714578e7aa))


### Bug Fixes

* **ai:** surface real embedding errors and accept local-service response shapes ([46fb278](https://github.com/atbeta/notefast/commit/46fb278a2260d7c02799b07cffbd3f00030f75b5))
* **ai:** tag AI writes with actor='ai' in document history ([8ad2422](https://github.com/atbeta/notefast/commit/8ad242235ab9c7f82aa5576c72fd7afa563dd3b3))
* **mcp:** tag notefast_update_block revisions with actor='mcp' ([5e409af](https://github.com/atbeta/notefast/commit/5e409af266c7f2ed5af81fc846cceaaac371ebbc))
* **tauri:** clamp initial window size to monitor, theme the splash ([eebbe15](https://github.com/atbeta/notefast/commit/eebbe159fb0b7a968d215029791faa100f53c285))

## [0.38.0](https://github.com/atbeta/notefast/compare/v0.37.3...v0.38.0) (2026-08-04)


### Features

* **server:** persist UI preferences (theme/locale) server-side ([c74d787](https://github.com/atbeta/notefast/commit/c74d7870223df5b0bbe75c953d58972cff707073))
* **tauri:** enforce single instance ([57d7ab3](https://github.com/atbeta/notefast/commit/57d7ab3044cb8154d477a0bb9fd08923feed413f))
* **web:** block browser context menu in native shells ([b5ca487](https://github.com/atbeta/notefast/commit/b5ca4870e1e7087146e287b908b06770ae71767d))


### Bug Fixes

* **engine:** fixed loopback port for stable origin, kill startup flicker ([227a248](https://github.com/atbeta/notefast/commit/227a248e1fbd6c98b92d3b99de9ebc1af0b3ada9))

## [0.37.3](https://github.com/atbeta/notefast/compare/v0.37.2...v0.37.3) (2026-08-04)


### Bug Fixes

* **ci:** install tauri CLI deps before NSIS build ([e36f95f](https://github.com/atbeta/notefast/commit/e36f95f6e609c9ee7dc10bac3ecb4ed2b0c4d981))

## [0.37.2](https://github.com/atbeta/notefast/compare/v0.37.1...v0.37.2) (2026-08-04)


### Bug Fixes

* **ai:** route DashScope rerank to compatible-api, dedupe save toast ([659d5b0](https://github.com/atbeta/notefast/commit/659d5b0fc94d7036fbffa9070143699d98431925))
* **ci:** prepare engine resources before cargo build ([4ab7ef7](https://github.com/atbeta/notefast/commit/4ab7ef787913256e99bfa81513201d83f25ac006))

## [0.37.1](https://github.com/atbeta/notefast/compare/v0.37.0...v0.37.1) (2026-08-04)


### Bug Fixes

* **ai:** update chat model defaults to latest provider models ([784a7db](https://github.com/atbeta/notefast/commit/784a7db7e796f9f147c8124122e62606bcaee67e))
* **ci:** give Cargo.toml extra-file an explicit toml type ([12f9b12](https://github.com/atbeta/notefast/commit/12f9b12421551d38fe2b7492e77ff5a59c6b016f))

## [0.37.0](https://github.com/atbeta/notefast/compare/v0.36.0...v0.37.0) (2026-08-04)


### Features

* **ai:** add DashScope preset and default new providers to custom ([8daa4b5](https://github.com/atbeta/notefast/commit/8daa4b5fd94fe24913501d8ef76e793b5dd5627d))
* **ai:** rebuild entity graph on demand ([26e42c6](https://github.com/atbeta/notefast/commit/26e42c621165986729b60f077f6f2e50230423c6))
* **clients:** distinguish dev builds, versioned release artifacts ([1fa8af8](https://github.com/atbeta/notefast/commit/1fa8af8fedd0e2a742e17b4e215c12ea79a0544b))
* **server:** add /internal/shutdown route for embedded shells ([b7919a4](https://github.com/atbeta/notefast/commit/b7919a4d57262177cd1f3907b1915808b9136eb2))
* **tauri:** add Windows desktop client shell ([e3ee3f2](https://github.com/atbeta/notefast/commit/e3ee3f2fd93a2aaeb629f67d62db7218f59c8dd8))
* **web:** custom titlebar for Tauri shells ([5fd5888](https://github.com/atbeta/notefast/commit/5fd5888c4b05236c72d078dbb39721457ef0ff42))
* **web:** installable PWA shell and self-hosted fonts ([faab2b8](https://github.com/atbeta/notefast/commit/faab2b88e76567ac16279c3994378c54cc95431b))
* **web:** show shared badge in document list ([3daccae](https://github.com/atbeta/notefast/commit/3daccae0ccd7070d0386218bd69c274fa93c1a0a))


### Bug Fixes

* **clients:** black strip on maximized window, icon-only titlebar ([f8bb4d3](https://github.com/atbeta/notefast/commit/f8bb4d30e0a8b3f8f12cfc761705e4bfd18d817e))
* **clients:** drop centered titlebar icon (bordered button look) ([07796de](https://github.com/atbeta/notefast/commit/07796deda71ad4f714e1580829449c652eb08c87))
* **tauri:** auto-locate engine in dev without NOTEFAST_ENGINE_DIR ([e948352](https://github.com/atbeta/notefast/commit/e948352c6ba1e4eb6119c70a9de5d1cb1430758b))
* **tauri:** grant IPC to engine origin, use Windows-style titlebar icons ([b42145a](https://github.com/atbeta/notefast/commit/b42145ac25fec090540dd23122bea843f3b459fb))
* **web:** doc-wide backlinks with source title and block anchor ([fca4087](https://github.com/atbeta/notefast/commit/fca4087c8ccf1417132d599354032e209dc117ac))
* **web:** hide tag filter in untagged view ([813c133](https://github.com/atbeta/notefast/commit/813c13352bb928f56ad4fca18f87483ae2263e74))
* **web:** make /settings/ai deep link work and simplify chat not-configured state ([23032d6](https://github.com/atbeta/notefast/commit/23032d66716943866846be04efb959430bcd7411))
* **web:** match sidebar toggle icon color with other icons ([9f07d20](https://github.com/atbeta/notefast/commit/9f07d205025797c4bd548a2d5f817a9f8c039bae))
* **web:** prefer Segoe UI for latin text on Windows ([0f08d2d](https://github.com/atbeta/notefast/commit/0f08d2dae9d3a75911d83ec6f482bc6ee497ec43))
* **web:** refresh inbox/archived counts on doc changes ([73fb5aa](https://github.com/atbeta/notefast/commit/73fb5aa69afea7a90b7d2ff32768f1b39c58eb94))

## [0.36.0](https://github.com/atbeta/notefast/compare/v0.35.0...v0.36.0) (2026-08-03)


### Features

* **web:** block-level menu in reading mode (copy link/content, ask AI) ([239130c](https://github.com/atbeta/notefast/commit/239130c2b6d8f71c7a91ecb2b6ec6104dbbf5148))

## [0.35.0](https://github.com/atbeta/notefast/compare/v0.34.0...v0.35.0) (2026-08-03)


### Features

* **clients:** DMG volume icon — reuse AppIcon.icns as .VolumeIcon.icns ([dc33f9d](https://github.com/atbeta/notefast/commit/dc33f9dd2b42a80b2bfedd406715639ba23ffae8))
* **clients:** DMG window layout — branded background + icon positions ([da135a0](https://github.com/atbeta/notefast/commit/da135a0bd1648d99ce8904b3280ef7059642abce))

## [0.34.0](https://github.com/atbeta/notefast/compare/v0.33.1...v0.34.0) (2026-08-03)


### Features

* **server:** tighten entity extraction quality ([066d5e0](https://github.com/atbeta/notefast/commit/066d5e0f3187495e0ca3fdb742cc8b8941866357))


### Bug Fixes

* **clients:** exclude engine tarball from app bundle — notarization Invalid ([c3df61f](https://github.com/atbeta/notefast/commit/c3df61f2fe75491ea50c01f41c6a87329d50cff8))

## [0.33.1](https://github.com/atbeta/notefast/compare/v0.33.0...v0.33.1) (2026-08-03)


### Bug Fixes

* **clients:** notarization Invalid — trim engine JIT entitlements, add timestamps ([3ad6bd2](https://github.com/atbeta/notefast/commit/3ad6bd2075b08cf234ddd37f3b7623b4c6e771f6))
* **web:** raise text selection contrast in dark mode ([162c10a](https://github.com/atbeta/notefast/commit/162c10a55bd610df01e95982d92490cb241ebf03))
* **web:** refresh inbox list on external doc changes ([e4898b2](https://github.com/atbeta/notefast/commit/e4898b2e7048c5a335087bf2f90c0a174a65cf59))

## [0.33.0](https://github.com/atbeta/notefast/compare/v0.32.0...v0.33.0) (2026-08-03)


### Features

* **clients:** macOS shell — menus, deep links, sync panel, version check ([c0209ef](https://github.com/atbeta/notefast/commit/c0209efe3a989f1a43abc0b1fa70a6365d0fd625))
* **clients:** polish macOS app icon — depth gradient, glass gloss, glyph shadow ([d2c7a77](https://github.com/atbeta/notefast/commit/d2c7a775cae37824f96e27d66f63d0c06159fd5c))
* **clients:** scaffold macOS native client shell ([0bdd489](https://github.com/atbeta/notefast/commit/0bdd489158694a784eb70993d23dcc4c3a9dec6a))
* **server,clients:** fast shutdown via SSE close, app icon, quit-on-window-close ([6eb0af0](https://github.com/atbeta/notefast/commit/6eb0af05de45eb8acf26eff7a311438933e2749c))


### Bug Fixes

* **clients,web:** native shell — hide web sidebar, fix empty-list spinner ([60fd23f](https://github.com/atbeta/notefast/commit/60fd23f0d0adcfc71676a69ea4cc794f5a70f827))
* **clients:** full-window web UI, drop native sidebar ([e555a31](https://github.com/atbeta/notefast/commit/e555a317aaeb4f7e155a2b695254b8ccfec274e4))
* **clients:** menu-intercepted Cmd+K/J — dispatch synthetic keydown to page ([4efd752](https://github.com/atbeta/notefast/commit/4efd7526d0dc21f33b2ee3d0c7185dc770d07067))
* **web:** Cmd+K/J close palette/chat even when its input is focused ([3d46334](https://github.com/atbeta/notefast/commit/3d46334134f1e17ac8e4fba3232027d4f8f7db64))
* **web:** Cmd+Shift+D theme toggle works while palette is open ([f7f7810](https://github.com/atbeta/notefast/commit/f7f7810f6de82e2420c8ff9c9aeaf86053f2cce3))
* **web:** restore WKWebView key focus after command palette closes ([d61b447](https://github.com/atbeta/notefast/commit/d61b447ac998d6e0b0a44ead6cd89e09045fec8b))

## [0.32.0](https://github.com/atbeta/notefast/compare/v0.31.0...v0.32.0) (2026-08-03)


### Features

* **server,web:** add embedded engine bootstrap and packaging pipeline ([e7f0902](https://github.com/atbeta/notefast/commit/e7f0902f1e3768201dddb195d54a7408417b4108))


### Bug Fixes

* **server:** revoke web sessions when auth password changes ([ce1e25e](https://github.com/atbeta/notefast/commit/ce1e25e921a0ab6de752a9231a1bce4afec09e2e))

## [0.31.0](https://github.com/atbeta/notefast/compare/v0.30.0...v0.31.0) (2026-08-02)


### Features

* **ai:** make the assistant language follow the UI language ([281cdf9](https://github.com/atbeta/notefast/commit/281cdf90a151f1977f89040396e0a96a77c1a5b5))
* **server:** full-KB archive export and own-format zip import ([b46a0ab](https://github.com/atbeta/notefast/commit/b46a0ab9efe551354f52d9303ad2073b60904399))
* **web,server:** show current doc state in history and refresh on save ([001d079](https://github.com/atbeta/notefast/commit/001d0791306913608c1caed22ce5247703e67817))
* **web:** add English locale pack, making the language picker functional ([ae56489](https://github.com/atbeta/notefast/commit/ae56489f66c6bae0ebf55388b891d77c31f1140c))
* **web:** add i18n with language picker and full UI string extraction ([5f70efb](https://github.com/atbeta/notefast/commit/5f70efb2ab024545718fe16b379aef5ae48f4398))
* **web:** archive panel — S3-compatible label, enable toggle, export/import ([a7ebf12](https://github.com/atbeta/notefast/commit/a7ebf12156feaa05b275b21d37847a512cc3c20b))
* **web:** localize server errors via error code mapping ([3df922d](https://github.com/atbeta/notefast/commit/3df922d9d9affda87c65eea74425b5c5881495b3))


### Bug Fixes

* **web:** portal confirm dialog and rename modal to body ([2f8ac87](https://github.com/atbeta/notefast/commit/2f8ac8723918e1400ab384beca549634152c3975))

## [0.30.0](https://github.com/atbeta/notefast/compare/v0.29.0...v0.30.0) (2026-08-02)


### Features

* **ai:** support enable/disable toggle for chat/embedding providers ([9090788](https://github.com/atbeta/notefast/commit/90907884576f588f6049430463f1097f3f8d80ce))
* **backup:** rework backup & sync architecture ([968e27b](https://github.com/atbeta/notefast/commit/968e27b59b87f67c5cb71b22bd6f99777ccd215b))
* **graph:** entity co-occurrence graph UI with force-directed explorer ([ce6dc00](https://github.com/atbeta/notefast/commit/ce6dc0085a8c6072313724ea569f9b198659d105))
* **graph:** node glow, entity descriptions, alias merge, MCP entity tools ([d24c29b](https://github.com/atbeta/notefast/commit/d24c29b61bb148a8edcc82646dfe12a7a85f3b00))
* **graph:** notes graph mode and interaction polish ([16d2ed0](https://github.com/atbeta/notefast/commit/16d2ed00e0df3608958f6c86da43fa77413a4433))
* **storage:** unify backup/sync/archive on a shared connection library ([45c3e61](https://github.com/atbeta/notefast/commit/45c3e6112d91136e657231aa5837783cb93a7ded))
* **sync:** archive includes images; make archive manual-only ([8fc99f7](https://github.com/atbeta/notefast/commit/8fc99f77b094f144f1b565e926eb48fc44757e99))
* **sync:** self-asserted device identity with shared-storage registry ([d58e04e](https://github.com/atbeta/notefast/commit/d58e04ea49e0f189f6f76619ac99ccddcd91bc1f))
* **ui:** global sync status pill, simplified sync panel status ([b8c756d](https://github.com/atbeta/notefast/commit/b8c756d5aaff9ca13108bad018edbed9611fca31))
* **web:** polish graph view visuals and interactions ([e7e8bfc](https://github.com/atbeta/notefast/commit/e7e8bfc61843d8c45fa622a5ecd4d4c9262261dc))
* **web:** reorganize settings page ([28cd199](https://github.com/atbeta/notefast/commit/28cd1992bef12205a97315022257bbe0c7a3f0f4))


### Bug Fixes

* **graph:** gate description loop on autoLink, confirm merges, bound degree pool, regenerate descriptions ([090c093](https://github.com/atbeta/notefast/commit/090c0937cf98adb58a336209a734c46036bd01f3))
* **sync:** lazy-rebuild S3 client when backup config changes ([db73933](https://github.com/atbeta/notefast/commit/db73933975a552b9e6b76ca70f621f2a7ccfe787))
* **ui:** move sync status pill to bottom-right ([855297f](https://github.com/atbeta/notefast/commit/855297f6b375536466266ec550a8a98a0f5c16a5))
* **ui:** remove redundant disable buttons, fix sync pill overlap ([ce4b135](https://github.com/atbeta/notefast/commit/ce4b13532a952d60da576936a76aa7f42edd8dae))
* **ui:** storage locations shared cache — dropdowns update instantly ([ecd6ae0](https://github.com/atbeta/notefast/commit/ecd6ae02b15a70548744af7044b15acc5a9b2bda))
* **ui:** tidy panel titles, merge archive S3/WebDAV into connection ([47d4d4b](https://github.com/atbeta/notefast/commit/47d4d4b95e2f63aca9f17afef52e2b4314b94e32))
* **web:** hide zero counts in page headers and align entity kind colors ([cd6cd44](https://github.com/atbeta/notefast/commit/cd6cd44b4b8d6b54b89f662d3972e2b29bc12dda))
* **web:** unify list skeletons across home/inbox/archived/entities ([b87f035](https://github.com/atbeta/notefast/commit/b87f0355cdf5ff86f6385855213ae721e07569de))

## [0.29.0](https://github.com/atbeta/notefast/compare/v0.28.0...v0.29.0) (2026-08-01)


### Features

* **backup:** content-addressed media sync to S3 ([8c640ef](https://github.com/atbeta/notefast/commit/8c640ef06eacd9edc0e879958b90dcd38331a9ce))
* **sync:** auto-sync after edits, status indicators, and syncPull ([4a261fe](https://github.com/atbeta/notefast/commit/4a261fec9caa89882fd5add7b035b7ce30a1fd9d))
* **sync:** protocol manager orchestrating publish/consume with persisted state ([bfd2c0f](https://github.com/atbeta/notefast/commit/bfd2c0f3974f975a708a10c8e5da30551e0fd2cb))
* **sync:** publish/consume change-log protocol over shared S3 ([353b5d3](https://github.com/atbeta/notefast/commit/353b5d31fbdd3097851f88841c21522f77b2814b))
* **sync:** snapshot fallback, compaction, and auto-sync timer ([2d4c443](https://github.com/atbeta/notefast/commit/2d4c4430c1109a037114266a678834c770646f16))


### Bug Fixes

* **history:** local-time display, line diff, and change source ([e5d979c](https://github.com/atbeta/notefast/commit/e5d979c068d39f6da159593de339c9d63139468b))
* **ui:** backup/archive panel fixes — save, timezone, prefix, help tips ([cd64796](https://github.com/atbeta/notefast/commit/cd64796e0eb3bc5f45595f9dc1b126fb7394a295))

## [0.28.0](https://github.com/atbeta/notefast/compare/v0.27.0...v0.28.0) (2026-08-01)


### Features

* **web:** replace textarea editor with CodeMirror 6 mixed renderer ([fa165bd](https://github.com/atbeta/notefast/commit/fa165bd3c90f127017a4bab417870a9148413680))

## [0.27.0](https://github.com/atbeta/notefast/compare/v0.26.0...v0.27.0) (2026-08-01)


### Features

* **auth:** replace password-in-localStorage with revocable Bearer session tokens ([824c9a4](https://github.com/atbeta/notefast/commit/824c9a412021d12fbbeebc73572ea7e6f86556db))
* **chat:** require human confirmation for AI write tools ([d72a89a](https://github.com/atbeta/notefast/commit/d72a89a8d631c5724253c57801b5e237344781bd))
* **history:** block content revision history with undo/restore ([93cd61e](https://github.com/atbeta/notefast/commit/93cd61e5b1b954c35f977eb1cbbd4dfcaa32ac48))
* **hooks:** document-level lifecycle hooks + write-path audit events ([8187301](https://github.com/atbeta/notefast/commit/8187301fd5c9c671c3a6b63cc95f8ccafacae17a))


### Bug Fixes

* **web:** mobile UX — adaptive padding, panel, title button and outline ([7d8fa53](https://github.com/atbeta/notefast/commit/7d8fa53efb8fb68d30dedd4888b3b12b3163bdb1))
* **web:** polish UI copy — remove technical jargon and colloquial phrasing ([475037c](https://github.com/atbeta/notefast/commit/475037c67b9e18ac983fafae6aa6c0f9d4f1c535))

## [0.26.0](https://github.com/atbeta/notefast/compare/v0.25.1...v0.26.0) (2026-08-01)


### Features

* **ui:** tighten visual hierarchy across list, sidebar, AI, and reading ([451079f](https://github.com/atbeta/notefast/commit/451079f15e455e753a5e933d462a3328fc428f93))

## [0.25.1](https://github.com/atbeta/notefast/compare/v0.25.0...v0.25.1) (2026-07-31)


### Bug Fixes

* **web:** extract PinnedViewItem to fix React hooks [#310](https://github.com/atbeta/notefast/issues/310) ([596a23f](https://github.com/atbeta/notefast/commit/596a23f79f090315b25065f09a30ac707b6566bc))

## [0.25.0](https://github.com/atbeta/notefast/compare/v0.24.0...v0.25.0) (2026-07-31)


### Features

* **ai:** include current doc content in chat prompt context ([873a4e3](https://github.com/atbeta/notefast/commit/873a4e373d9e1e5f8542b5432d878fd0675ae3e7))
* **ui:** HelpTip compact tooltips for settings; guard image-only chats without vision ([b86a7e8](https://github.com/atbeta/notefast/commit/b86a7e8ce3159fc7277972be4065ada2687f18a7))


### Bug Fixes

* pinned views rename (API + inline edit) ([5e1db37](https://github.com/atbeta/notefast/commit/5e1db3768fbf6456c75429166fb97dfdf9e6ca68))
* reranker preset persistence; catch image error in streamChat fallback ([5ddb91d](https://github.com/atbeta/notefast/commit/5ddb91da2a0ff6789fd74c9a411ca516f702c143))

## [0.24.0](https://github.com/atbeta/notefast/compare/v0.23.0...v0.24.0) (2026-07-31)


### Features

* **server,web:** login audit log with IP/device tracking ([f24340b](https://github.com/atbeta/notefast/commit/f24340b67ceac8915b76d9200667e4c4968bd54b))
* **ui:** redesign settings as single-page dashboard and refine border radius ([4fd712f](https://github.com/atbeta/notefast/commit/4fd712fadb482f863beea2d94a9cb941eecb559b))
* **web,server:** auto-save editor drafts + cross-platform shortcut display ([ea683b0](https://github.com/atbeta/notefast/commit/ea683b0cdf89c1f6536c51a5e8e12103416136f7))

## [0.23.0](https://github.com/atbeta/notefast/compare/v0.22.0...v0.23.0) (2026-07-29)


### ⚠ BREAKING CHANGES

* **autolink:** autolink_suggestions is dropped and the review APIs/MCP tools are removed.

### Features

* **autolink:** replace human review with high-confidence auto-linking ([8850366](https://github.com/atbeta/notefast/commit/885036653926d75711046a8bda77e74ab62bf768))
* **server,web:** entity layer - the graph's mention edges ([bbb2057](https://github.com/atbeta/notefast/commit/bbb205773268737b588760122147592118723455))
* **server:** context-enriched indexed text + retrieval P0 correctness fixes ([d8d58c2](https://github.com/atbeta/notefast/commit/d8d58c2eae5c84d3a61f2e43723681c307a34766))
* **server:** dual-path lexical search (FTS + LIKE) for Chinese recall ([790f1c2](https://github.com/atbeta/notefast/commit/790f1c21c033a10e1abe999d58031cda6891314e))
* **server:** graph context channel + fusion layer corrections ([ff81a3c](https://github.com/atbeta/notefast/commit/ff81a3c34d77e48e988bdf92df6a076d4cd161d3))
* **server:** retrieval evaluation harness with synthetic + private tracks ([2bc8204](https://github.com/atbeta/notefast/commit/2bc82040322b7d0b1e8441686c025972335b92ab))


### Bug Fixes

* **core:** strip inline &lt;think&gt; reasoning from non-stream chat responses ([468a9e3](https://github.com/atbeta/notefast/commit/468a9e38daa7f65c45f5c3168b102aebdabc9dfa))

## [0.22.0](https://github.com/atbeta/notefast/compare/v0.21.0...v0.22.0) (2026-07-28)


### Features

* **server,web:** single-doc export as Markdown or zip with images ([20fd187](https://github.com/atbeta/notefast/commit/20fd187d624db7ac3c7f78d75b9863097f7fd7c6))
* **server:** MCP create_doc_from_file with chunked markdown staging ([ec6a50b](https://github.com/atbeta/notefast/commit/ec6a50b8cc301d18a7734481a1c85d1604de8457))
* **server:** unauthenticated dev mode by default when no auth configured ([a09c170](https://github.com/atbeta/notefast/commit/a09c170d83e60d6d2501b236ea622bdd6b1312dc))
* **web:** add shared doc overflow menu on list rows ([27c0a92](https://github.com/atbeta/notefast/commit/27c0a92c7ae5ff1cee18cebc996c1dc5fa96d6af))
* **web:** block-level citation navigation and readable citation chips ([31195da](https://github.com/atbeta/notefast/commit/31195da58f6e4e83cf309c24073b861ed5b76dfe))
* **web:** lighten share UI to anchored popover with shared state ([0001e8f](https://github.com/atbeta/notefast/commit/0001e8fa8c01de86f751bebb456e75877568c7a9))
* **web:** low-saturation brand indigo for selection, primary actions, AI ([81e1f52](https://github.com/atbeta/notefast/commit/81e1f52bcdeae37ad26732d4a0b910a94fd49ecc))
* **web:** micro-interaction and reading-experience polish ([dda89de](https://github.com/atbeta/notefast/commit/dda89decf34d38f0e3d2079093b5572a8ddc9dd8))


### Bug Fixes

* **server,web:** auth hardening, share page security headers, archive share cascade ([e517dec](https://github.com/atbeta/notefast/commit/e517dec5d7837b82cae25b4aad747b9a5985ec88))
* **server,web:** return real source_id in autolink apply, graceful shutdown, share guardrails ([8b0bd08](https://github.com/atbeta/notefast/commit/8b0bd08795074500a9bd0b1c5542e58afea443e3))
* **server:** exclude soft-deleted blocks from vector indexing and retrieval ([1117f64](https://github.com/atbeta/notefast/commit/1117f64620254ad6ecadd2c370d74b1047c5171f))
* **server:** register SSE idle-timeout middleware before routes ([4fe928e](https://github.com/atbeta/notefast/commit/4fe928e7c4ad6c10f19de378c56b08395f375722))
* **server:** robustness — index job map pruning, autoExport single loop, per-route SSE timeout, ms timestamps ([689f7fa](https://github.com/atbeta/notefast/commit/689f7faea35b816363846fdf350d057da1962abe))
* **web:** doc lifecycle UX — read-mode landing, per-doc edit state, draft visibility ([6a280df](https://github.com/atbeta/notefast/commit/6a280df43e171265fffabede6339422cffa29187))

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
