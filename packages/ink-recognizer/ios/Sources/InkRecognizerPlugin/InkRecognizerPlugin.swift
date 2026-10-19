import Foundation
import Capacitor
import UIKit
import Vision

/// 기기 내장 손글씨 인식 (Apple Vision). 네트워크 없이 기기 안에서만 처리한다.
/// 웹 쪽에서 필기 획만 흰 바탕에 그린 PNG 를 보내면, 줄·단어 위치와 후보 문자열을 돌려준다.
@objc(InkRecognizerPlugin)
public class InkRecognizerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "InkRecognizerPlugin"
    public let jsName = "InkRecognizer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognizeImage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "recognizeStrokes", returnType: CAPPluginReturnPromise)
    ]

    private let queue = DispatchQueue(label: "inknote.recognizer", qos: .utility)

    private func makeRequest() -> VNRecognizeTextRequest {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        if #available(iOS 16.0, *) {
            req.revision = VNRecognizeTextRequestRevision3
            req.automaticallyDetectsLanguage = false
        }
        return req
    }

    private func supportedLanguages() -> [String] {
        let req = makeRequest()
        return (try? req.supportedRecognitionLanguages()) ?? []
    }

    @objc func info(_ call: CAPPluginCall) {
        call.resolve(["available": true, "engine": "vision", "languages": supportedLanguages(), "ready": true])
    }

    @objc func prepare(_ call: CAPPluginCall) {
        call.resolve(["ready": true])
    }

    @objc func recognizeStrokes(_ call: CAPPluginCall) {
        call.unimplemented("iOS 에서는 recognizeImage 를 사용합니다")
    }

    @objc func recognizeImage(_ call: CAPPluginCall) {
        guard let b64 = call.getString("image"),
              let data = Data(base64Encoded: b64),
              let image = UIImage(data: data)?.cgImage else {
            call.reject("이미지를 읽을 수 없습니다")
            return
        }
        let wanted = call.getArray("languages", String.self) ?? ["ko-KR", "en-US"]
        queue.async {
            let req = self.makeRequest()
            let supported = (try? req.supportedRecognitionLanguages()) ?? []
            let langs = wanted.filter { supported.contains($0) }
            if !langs.isEmpty { req.recognitionLanguages = langs }
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            do {
                try handler.perform([req])
            } catch {
                call.reject("인식 실패: \(error.localizedDescription)")
                return
            }
            var lines: [[String: Any]] = []
            for obs in req.results ?? [] {
                let cands = obs.topCandidates(5)
                guard let top = cands.first, !top.string.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
                var words: [[String: Any]] = []
                let s = top.string
                s.enumerateSubstrings(in: s.startIndex..<s.endIndex, options: .byWords) { sub, range, _, _ in
                    guard let sub = sub, let box = try? top.boundingBox(for: range)?.boundingBox else { return }
                    words.append(Self.rect(box, ["text": sub]))
                }
                lines.append(Self.rect(obs.boundingBox, [
                    "text": s,
                    "alts": cands.dropFirst().map { $0.string },
                    "words": words
                ]))
            }
            call.resolve(["lines": lines])
        }
    }

    /// Vision 정규화 좌표(좌하단 원점) → 좌상단 원점
    private static func rect(_ r: CGRect, _ extra: [String: Any]) -> [String: Any] {
        var out = extra
        out["x"] = r.origin.x
        out["y"] = 1 - r.origin.y - r.size.height
        out["w"] = r.size.width
        out["h"] = r.size.height
        return out
    }
}
