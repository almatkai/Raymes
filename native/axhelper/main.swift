import AppKit
import ApplicationServices
import Foundation

struct Input: Decodable {
  let action: String
  let query: String?
}

struct Frame: Codable {
  let x: Double
  let y: Double
  let w: Double
  let h: Double
}

struct AXNode: Codable {
  let role: String?
  let label: String?
  let value: String?
  let frame: Frame?
  let children: [AXNode]
}

func axValue<T>(_ element: AXUIElement, _ key: String, as type: T.Type) -> T? {
  var out: CFTypeRef?
  let err = AXUIElementCopyAttributeValue(element, key as CFString, &out)
  guard err == .success, let raw = out else { return nil }
  return raw as? T
}

func elementFrame(_ element: AXUIElement) -> Frame? {
  guard let posValue: AXValue = axValue(element, kAXPositionAttribute as String, as: AXValue.self),
        let sizeValue: AXValue = axValue(element, kAXSizeAttribute as String, as: AXValue.self)
  else { return nil }

  var point = CGPoint.zero
  var size = CGSize.zero
  guard AXValueGetValue(posValue, .cgPoint, &point), AXValueGetValue(sizeValue, .cgSize, &size) else {
    return nil
  }
  return Frame(x: point.x, y: point.y, w: size.width, h: size.height)
}

func nodeFromElement(_ element: AXUIElement, depth: Int, maxDepth: Int) -> AXNode {
  let role: String? = axValue(element, kAXRoleAttribute as String, as: String.self)
  let label: String? = axValue(element, kAXTitleAttribute as String, as: String.self)
    ?? axValue(element, kAXDescriptionAttribute as String, as: String.self)
  let value: String? = axValue(element, kAXValueAttribute as String, as: String.self)

  if depth >= maxDepth {
    return AXNode(role: role, label: label, value: value, frame: elementFrame(element), children: [])
  }

  let kids: [AXUIElement] = axValue(element, kAXChildrenAttribute as String, as: [AXUIElement].self) ?? []
  let childNodes = kids.map { nodeFromElement($0, depth: depth + 1, maxDepth: maxDepth) }

  return AXNode(role: role, label: label, value: value, frame: elementFrame(element), children: childNodes)
}

func findFirst(_ element: AXUIElement, query: String, depth: Int, maxDepth: Int) -> Frame? {
  let q = query.lowercased()
  let role: String = axValue(element, kAXRoleAttribute as String, as: String.self) ?? ""
  let title: String = axValue(element, kAXTitleAttribute as String, as: String.self) ?? ""
  let desc: String = axValue(element, kAXDescriptionAttribute as String, as: String.self) ?? ""

  if role.lowercased().contains(q) || title.lowercased().contains(q) || desc.lowercased().contains(q) {
    return elementFrame(element)
  }

  if depth >= maxDepth { return nil }
  let kids: [AXUIElement] = axValue(element, kAXChildrenAttribute as String, as: [AXUIElement].self) ?? []
  for child in kids {
    if let match = findFirst(child, query: query, depth: depth + 1, maxDepth: maxDepth) {
      return match
    }
  }
  return nil
}

func jsonOut(_ payload: Any) {
  guard JSONSerialization.isValidJSONObject(payload),
        let data = try? JSONSerialization.data(withJSONObject: payload, options: [])
  else {
    fputs("{\"error\":\"invalid json payload\"}\n", stderr)
    exit(1)
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  jsonOut(["error": message])
  exit(1)
}

let trustedOpts = [kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true] as CFDictionary
if !AXIsProcessTrustedWithOptions(trustedOpts) {
  fail("Accessibility access not granted. Please enable it in System Settings -> Privacy & Security -> Accessibility")
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard !inputData.isEmpty else { fail("empty stdin") }

let input: Input
do {
  input = try JSONDecoder().decode(Input.self, from: inputData)
} catch {
  fail("invalid input json: \(error.localizedDescription)")
}

guard let app = NSWorkspace.shared.frontmostApplication else {
  fail("no frontmost application")
}

let appElement = AXUIElementCreateApplication(app.processIdentifier)
var focusedValue: CFTypeRef?
let focusedErr = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedValue)
let root: AXUIElement
if focusedErr == .success, let window = focusedValue as! AXUIElement? {
  root = window
} else {
  root = appElement
}

switch input.action {
case "snapshot":
  let snapshot = nodeFromElement(root, depth: 0, maxDepth: 6)
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(["elements": [snapshot]]) else {
    fail("failed to encode snapshot")
  }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)

case "find":
  guard let q = input.query, !q.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
    fail("query is required for find")
  }
  if let frame = findFirst(root, query: q, depth: 0, maxDepth: 8) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(["frame": frame]) else {
      fail("failed to encode frame")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  } else {
    jsonOut(["frame": NSNull()])
  }

default:
  fail("unknown action: \(input.action)")
}
