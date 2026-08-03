import XCTest
@testable import NoteFast

final class SemVerTests: XCTestCase {
    func testCompareBasics() {
        XCTAssertEqual(SemVer.compare("0.31.0", "0.31.0"), 0)
        XCTAssertEqual(SemVer.compare("0.31.0", "0.30.0"), 1)
        XCTAssertEqual(SemVer.compare("0.30.0", "0.31.0"), -1)
        XCTAssertEqual(SemVer.compare("1.0.0", "0.99.0"), 1)
    }

    func testCompareMissingSegments() {
        XCTAssertEqual(SemVer.compare("0.31", "0.31.0"), 0)
        XCTAssertEqual(SemVer.compare("1", "1.0.0"), 0)
        XCTAssertEqual(SemVer.compare("0.31.0", "0.31.1"), -1)
    }

    func testVAndSuffix() {
        XCTAssertEqual(SemVer.compare("v0.31.0", "0.31.0"), 0)
        XCTAssertEqual(SemVer.compare("0.31.0-beta", "0.31.0"), 0)
        XCTAssertEqual(SemVer.compare("0.31.0+meta", "0.31.0"), 0)
    }

    func testNonNumericFallsBackToZero() {
        XCTAssertEqual(SemVer.compare("abc", "0.0.0"), 0)
    }

    func testIsAtLeast() {
        XCTAssertTrue(SemVer.isAtLeast("0.31.0", min: "0.31.0"))
        XCTAssertTrue(SemVer.isAtLeast("0.32.0", min: "0.31.0"))
        XCTAssertFalse(SemVer.isAtLeast("0.30.9", min: "0.31.0"))
    }
}
