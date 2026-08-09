import XCTest
@testable import NoteFast

/// UpdateChecker：releases/latest 响应解析与新旧版本判定（网络请求本身不打真实 GitHub）
final class UpdateCheckerTests: XCTestCase {

    func testParse_normalWithVPrefix() {
        let json = #"{"tag_name":"v0.56.0","html_url":"https://github.com/atbeta/notefast/releases/tag/v0.56.0"}"#
        let info = UpdateChecker.parseLatestRelease(json: Data(json.utf8))
        XCTAssertEqual(info?.version, "0.56.0")
        XCTAssertEqual(info?.url.absoluteString, "https://github.com/atbeta/notefast/releases/tag/v0.56.0")
    }

    func testParse_tagWithoutVPrefix() {
        let json = #"{"tag_name":"0.56.0","html_url":"https://github.com/atbeta/notefast/releases/tag/0.56.0"}"#
        XCTAssertEqual(UpdateChecker.parseLatestRelease(json: Data(json.utf8))?.version, "0.56.0")
    }

    func testParse_malformed() {
        XCTAssertNil(UpdateChecker.parseLatestRelease(json: Data("not json".utf8)))
        XCTAssertNil(UpdateChecker.parseLatestRelease(json: Data(#"{}"#.utf8)))
        // 有 tag 无 html_url
        XCTAssertNil(UpdateChecker.parseLatestRelease(json: Data(#"{"tag_name":"v1.0.0"}"#.utf8)))
        // 空 tag
        XCTAssertNil(UpdateChecker.parseLatestRelease(
            json: Data(#"{"tag_name":"v","html_url":"https://example.com"}"#.utf8)))
    }

    func testIsNewer() {
        XCTAssertTrue(UpdateChecker.isNewer(latest: "0.56.0", than: "0.55.0"))
        XCTAssertFalse(UpdateChecker.isNewer(latest: "0.55.0", than: "0.55.0"))
        XCTAssertFalse(UpdateChecker.isNewer(latest: "0.55.0", than: "0.56.0"))
        // 预发布/构建元数据走 SemVer 既有语义（非数字段回退 0）
        XCTAssertTrue(UpdateChecker.isNewer(latest: "0.56.0", than: "0.55"))
    }
}
