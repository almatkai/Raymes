use std::collections::HashSet;
use std::io::Cursor;

use core_graphics::display::CGDisplay;
use core_graphics::event::{
  CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton, EventField,
  ScrollEventUnit,
};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::CGPoint;
use image::{DynamicImage, ImageBuffer, ImageFormat, Rgba};
use napi::bindgen_prelude::Buffer;
use napi::Error;
use napi_derive::napi;

/// `kCGEventSourceStateHIDSystemState` — physical key state from the HID driver.
const KCG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE: u32 = 1;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
  fn CGEventSourceKeyState(state_id: u32, key: CGKeyCode) -> bool;
}

fn physical_key_is_down(code: CGKeyCode) -> bool {
  unsafe { CGEventSourceKeyState(KCG_EVENT_SOURCE_STATE_HID_SYSTEM_STATE, code) }
}

fn event_source() -> napi::Result<CGEventSource> {
  CGEventSource::new(CGEventSourceStateID::HIDSystemState)
    .map_err(|_| Error::from_reason("failed to create CGEventSource"))
}

fn post_mouse_event(
  event_type: CGEventType,
  x: f64,
  y: f64,
  button: CGMouseButton,
) -> napi::Result<()> {
  let source = event_source()?;
  let event = CGEvent::new_mouse_event(source, event_type, CGPoint::new(x, y), button)
    .map_err(|_| Error::from_reason("failed to create mouse event"))?;
  event.post(CGEventTapLocation::HID);
  Ok(())
}

#[napi]
pub fn move_mouse(x: f64, y: f64) -> napi::Result<()> {
  post_mouse_event(CGEventType::MouseMoved, x, y, CGMouseButton::Left)
}

fn parse_button(button: &str) -> napi::Result<CGMouseButton> {
  match button {
    "left" => Ok(CGMouseButton::Left),
    "right" => Ok(CGMouseButton::Right),
    _ => Err(Error::from_reason("button must be 'left' or 'right'")),
  }
}

#[napi]
pub fn click(x: f64, y: f64, button: String) -> napi::Result<()> {
  let btn = parse_button(&button)?;
  let (down, up) = match btn {
    CGMouseButton::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp),
    CGMouseButton::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp),
    _ => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp),
  };

  post_mouse_event(down, x, y, btn)?;
  post_mouse_event(up, x, y, btn)
}

#[napi]
pub fn double_click(x: f64, y: f64) -> napi::Result<()> {
  let source = event_source()?;

  let down_1 = CGEvent::new_mouse_event(
    source.clone(),
    CGEventType::LeftMouseDown,
    CGPoint::new(x, y),
    CGMouseButton::Left,
  )
  .map_err(|_| Error::from_reason("failed to create first down event"))?;
  down_1.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 2);
  down_1.post(CGEventTapLocation::HID);

  let up_1 = CGEvent::new_mouse_event(
    source.clone(),
    CGEventType::LeftMouseUp,
    CGPoint::new(x, y),
    CGMouseButton::Left,
  )
  .map_err(|_| Error::from_reason("failed to create first up event"))?;
  up_1.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 2);
  up_1.post(CGEventTapLocation::HID);

  let down_2 = CGEvent::new_mouse_event(
    source.clone(),
    CGEventType::LeftMouseDown,
    CGPoint::new(x, y),
    CGMouseButton::Left,
  )
  .map_err(|_| Error::from_reason("failed to create second down event"))?;
  down_2.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 2);
  down_2.post(CGEventTapLocation::HID);

  let up_2 = CGEvent::new_mouse_event(
    source,
    CGEventType::LeftMouseUp,
    CGPoint::new(x, y),
    CGMouseButton::Left,
  )
  .map_err(|_| Error::from_reason("failed to create second up event"))?;
  up_2.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, 2);
  up_2.post(CGEventTapLocation::HID);

  Ok(())
}

fn keycode_for(key: &str) -> Option<CGKeyCode> {
  let key = key.to_lowercase();
  let code = match key.as_str() {
    "a" => 0,
    "s" => 1,
    "d" => 2,
    "f" => 3,
    "h" => 4,
    "g" => 5,
    "z" => 6,
    "x" => 7,
    "c" => 8,
    "v" => 9,
    "b" => 11,
    "q" => 12,
    "w" => 13,
    "e" => 14,
    "r" => 15,
    "y" => 16,
    "t" => 17,
    "1" => 18,
    "2" => 19,
    "3" => 20,
    "4" => 21,
    "6" => 22,
    "5" => 23,
    "=" => 24,
    "9" => 25,
    "7" => 26,
    "-" => 27,
    "8" => 28,
    "0" => 29,
    "]" => 30,
    "o" => 31,
    "u" => 32,
    "[" => 33,
    "i" => 34,
    "p" => 35,
    "l" => 37,
    "j" => 38,
    "'" => 39,
    "k" => 40,
    ";" => 41,
    "\\" => 42,
    "," => 43,
    "/" => 44,
    "n" => 45,
    "m" => 46,
    "." => 47,
    "tab" => 48,
    "space" => 49,
    "return" | "enter" => 36,
    "backspace" => 51,
    "escape" | "esc" => 53,
    "left" => 123,
    "right" => 124,
    "down" => 125,
    "up" => 126,
    _ => return None,
  };
  Some(code)
}

/// Returns whether a key is physically held (macOS HID state). Used for
/// push-to-talk style detection when `globalShortcut` only reports a single
/// callback per chord press.
#[napi]
pub fn is_physical_key_down(key: String) -> bool {
  let k = key.trim().to_lowercase();
  match k.as_str() {
    "space" => physical_key_is_down(49),
    // Left option (58) and right option (61)
    "option" | "alt" => physical_key_is_down(58) || physical_key_is_down(61),
    // Left shift (56), right shift (60)
    "shift" => physical_key_is_down(56) || physical_key_is_down(60),
    // Left control (59), right control (62)
    "control" | "ctrl" => physical_key_is_down(59) || physical_key_is_down(62),
    // Left command (55), right command (54)
    "command" | "cmd" => physical_key_is_down(55) || physical_key_is_down(54),
    other => keycode_for(other).is_some_and(physical_key_is_down),
  }
}

fn flags_for_mods(mods: &[String]) -> CGEventFlags {
  let set: HashSet<String> = mods.iter().map(|m| m.to_lowercase()).collect();
  let mut flags = CGEventFlags::CGEventFlagNull;
  if set.contains("shift") {
    flags |= CGEventFlags::CGEventFlagShift;
  }
  if set.contains("cmd") || set.contains("command") {
    flags |= CGEventFlags::CGEventFlagCommand;
  }
  if set.contains("ctrl") || set.contains("control") {
    flags |= CGEventFlags::CGEventFlagControl;
  }
  if set.contains("opt") || set.contains("option") || set.contains("alt") {
    flags |= CGEventFlags::CGEventFlagAlternate;
  }
  flags
}

#[napi]
pub fn press_key(key: String, mods: Vec<String>) -> napi::Result<()> {
  let keycode = keycode_for(&key).ok_or_else(|| Error::from_reason(format!("unknown key: {key}")))?;
  let source = event_source()?;
  let flags = flags_for_mods(&mods);

  let key_down = CGEvent::new_keyboard_event(source.clone(), keycode, true)
    .map_err(|_| Error::from_reason("failed to create key down event"))?;
  key_down.set_flags(flags);
  key_down.post(CGEventTapLocation::HID);

  let key_up = CGEvent::new_keyboard_event(source, keycode, false)
    .map_err(|_| Error::from_reason("failed to create key up event"))?;
  key_up.set_flags(flags);
  key_up.post(CGEventTapLocation::HID);
  Ok(())
}

#[napi]
pub fn type_text(text: String) -> napi::Result<()> {
  let source = event_source()?;
  for unit in text.encode_utf16() {
    let key_down = CGEvent::new_keyboard_event(source.clone(), 0, true)
      .map_err(|_| Error::from_reason("failed to create text key down event"))?;
    key_down.set_string_from_utf16_unchecked(&[unit]);
    key_down.post(CGEventTapLocation::HID);

    let key_up = CGEvent::new_keyboard_event(source.clone(), 0, false)
      .map_err(|_| Error::from_reason("failed to create text key up event"))?;
    key_up.set_string_from_utf16_unchecked(&[unit]);
    key_up.post(CGEventTapLocation::HID);
  }
  Ok(())
}

#[napi]
pub fn scroll(x: f64, y: f64, dx: i32, dy: i32) -> napi::Result<()> {
  move_mouse(x, y)?;
  let source = event_source()?;
  let event = CGEvent::new_scroll_event(source, ScrollEventUnit::PIXEL, 2, dy, dx, 0)
    .map_err(|_| Error::from_reason("failed to create scroll event"))?;
  event.post(CGEventTapLocation::HID);
  Ok(())
}

#[napi]
pub fn screenshot() -> napi::Result<Buffer> {
  let image = CGDisplay::main()
    .image()
    .ok_or_else(|| Error::from_reason("failed to capture display image"))?;

  let width = image.width() as u32;
  let height = image.height() as u32;
  let bytes_per_row = image.bytes_per_row();

  let data = image.data();
  let bytes = data.bytes();

  let mut rgba = Vec::with_capacity((width as usize) * (height as usize) * 4);
  for y in 0..height as usize {
    let row = &bytes[(y * bytes_per_row)..((y * bytes_per_row) + (width as usize * 4))];
    for px in row.chunks_exact(4) {
      // macOS screen capture is commonly BGRA
      rgba.push(px[2]);
      rgba.push(px[1]);
      rgba.push(px[0]);
      rgba.push(px[3]);
    }
  }

  let img: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_raw(width, height, rgba)
    .ok_or_else(|| Error::from_reason("failed to build image buffer"))?;

  let mut out = Cursor::new(Vec::new());
  DynamicImage::ImageRgba8(img)
    .write_to(&mut out, ImageFormat::Png)
    .map_err(|e| Error::from_reason(format!("failed to encode png: {e}")))?;

  Ok(Buffer::from(out.into_inner()))
}
