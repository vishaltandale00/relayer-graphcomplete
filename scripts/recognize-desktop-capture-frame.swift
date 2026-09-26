import Foundation
import Vision

struct Request: Decodable {
  let id: Int
  let file: String
}

struct Response: Encodable {
  let id: Int?
  let ready: Bool?
  let text: String?
  let error: String?
}

func write(_ response: Response) {
  let data = try! JSONEncoder().encode(response)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

write(Response(id: nil, ready: true, text: nil, error: nil))
while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let request = try? JSONDecoder().decode(Request.self, from: data) else {
    write(Response(id: nil, ready: nil, text: nil, error: "Invalid frame recognition request"))
    continue
  }

  do {
    let recognition = VNRecognizeTextRequest()
    recognition.recognitionLevel = .accurate
    recognition.usesLanguageCorrection = false
    recognition.recognitionLanguages = ["en-US"]
    let handler = VNImageRequestHandler(url: URL(fileURLWithPath: request.file), options: [:])
    try handler.perform([recognition])
    let text = (recognition.results ?? [])
      .compactMap { $0.topCandidates(1).first?.string }
      .joined(separator: "\n")
    write(Response(id: request.id, ready: nil, text: text, error: nil))
  } catch {
    write(Response(id: request.id, ready: nil, text: nil, error: error.localizedDescription))
  }
}
