#!/usr/bin/env swift
import Vision
import AppKit
import CoreImage

// ---- Argument parsing ----------------------------------------------------

func usage() -> Never {
    FileHandle.standardError.write(Data("""
        Usage:
          removebg.swift <input> <output>                       # Vision API mode
          removebg.swift <input> <output> --bg-color #RRGGBB    # Chroma-key mode
                          [--fuzz N]                            # 0-100 (default 10)

        Notes:
          * Vision mode = subject detection (VNGenerateForegroundInstanceMaskRequest).
          * --bg-color mode = treat the given color as background and make it
            transparent. Useful for white-card-on-light-bg cases where Vision fails.

        """.utf8))
    exit(1)
}

let argv = CommandLine.arguments
guard argv.count >= 3 else { usage() }

let inputPath = argv[1]
let outputPath = argv[2]

var bgColorHex: String? = nil
var fuzzPercent: Double = 10.0  // default 10

var i = 3
while i < argv.count {
    let arg = argv[i]
    switch arg {
    case "--bg-color":
        guard i + 1 < argv.count else {
            FileHandle.standardError.write(Data("Error: --bg-color requires a hex value (e.g. #f8f8f7).\n".utf8))
            exit(1)
        }
        bgColorHex = argv[i + 1]
        i += 2
    case "--fuzz":
        guard i + 1 < argv.count, let v = Double(argv[i + 1]) else {
            FileHandle.standardError.write(Data("Error: --fuzz requires a number 0-100.\n".utf8))
            exit(1)
        }
        if v < 0 || v > 100 {
            FileHandle.standardError.write(Data("Error: --fuzz must be in 0-100 range (got \(v)).\n".utf8))
            exit(1)
        }
        fuzzPercent = v
        i += 2
    case "-h", "--help":
        usage()
    default:
        FileHandle.standardError.write(Data("Error: unknown argument \(arg)\n".utf8))
        exit(1)
    }
}

// ---- Hex color parser ----------------------------------------------------

func parseHex(_ raw: String) -> (r: UInt8, g: UInt8, b: UInt8)? {
    var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    if s.lowercased().hasPrefix("0x") { s.removeFirst(2) }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
    let r = UInt8((v >> 16) & 0xFF)
    let g = UInt8((v >> 8) & 0xFF)
    let b = UInt8(v & 0xFF)
    return (r, g, b)
}

// ---- Output helper -------------------------------------------------------

func writePNG(cgImage: CGImage, to path: String) throws {
    let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    guard let tiff = nsImage.tiffRepresentation,
          let bitmap = NSBitmapImageRep(data: tiff),
          let png = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "removebg", code: 1, userInfo: [NSLocalizedDescriptionKey: "PNG encode failed"])
    }
    try png.write(to: URL(fileURLWithPath: path))
}

// ---- Mode dispatch -------------------------------------------------------

let inputURL = URL(fileURLWithPath: inputPath)

if let hex = bgColorHex {
    // ---- bg-color (chroma-key) mode --------------------------------------

    guard let target = parseHex(hex) else {
        FileHandle.standardError.write(Data("Error: invalid hex color \"\(hex)\". Expected #RRGGBB.\n".utf8))
        exit(1)
    }

    // Load via NSImage -> CGImage to support PNG/JPEG with proper colorspace.
    guard let nsImage = NSImage(contentsOf: inputURL),
          let cgImage = nsImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        FileHandle.standardError.write(Data("Error: Could not load image from \(inputPath)\n".utf8))
        exit(1)
    }

    let width = cgImage.width
    let height = cgImage.height
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    let bitsPerComponent = 8
    let bufSize = bytesPerRow * height

    // Allocate RGBA buffer and draw input into it (premultipliedLast = RGBA).
    var pixels = [UInt8](repeating: 0, count: bufSize)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo: UInt32 = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
    guard let ctx = CGContext(data: &pixels,
                              width: width,
                              height: height,
                              bitsPerComponent: bitsPerComponent,
                              bytesPerRow: bytesPerRow,
                              space: colorSpace,
                              bitmapInfo: bitmapInfo) else {
        FileHandle.standardError.write(Data("Error: Could not create CGContext\n".utf8))
        exit(1)
    }
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

    // Chroma-key: per-pixel distance to target. Anti-aliased band.
    // fuzz% is interpreted as a max channel-distance fraction of 255.
    // We use Euclidean distance in RGB (max ≈ 441.67 for 255,255,255 vs 0,0,0).
    // Threshold fully-transparent <= innerR, fully-opaque >= outerR, lerp inside.
    let maxDist = sqrt(3.0) * 255.0
    let outerR = (fuzzPercent / 100.0) * maxDist
    // Inner radius for the AA band: 70% of outer (gives smooth-ish edge,
    // but if fuzz is small the band is naturally narrow).
    let innerR = outerR * 0.7

    let tr = Double(target.r)
    let tg = Double(target.g)
    let tb = Double(target.b)

    var idx = 0
    for _ in 0..<height {
        for _ in 0..<width {
            let r = Double(pixels[idx])
            let g = Double(pixels[idx + 1])
            let b = Double(pixels[idx + 2])
            let origA = Double(pixels[idx + 3])

            let dr = r - tr
            let dg = g - tg
            let db = b - tb
            let dist = sqrt(dr*dr + dg*dg + db*db)

            let newAlpha: Double
            if dist <= innerR {
                newAlpha = 0
            } else if dist >= outerR {
                newAlpha = origA
            } else {
                // Linear interpolation in the band.
                let t = (dist - innerR) / max(outerR - innerR, 0.0001)
                newAlpha = origA * t
            }

            // Since buffer is premultipliedLast, we must scale RGB by alpha ratio.
            if origA > 0 {
                let scale = newAlpha / origA
                pixels[idx]     = UInt8(min(255, max(0, r * scale)))
                pixels[idx + 1] = UInt8(min(255, max(0, g * scale)))
                pixels[idx + 2] = UInt8(min(255, max(0, b * scale)))
            }
            pixels[idx + 3] = UInt8(min(255, max(0, newAlpha)))

            idx += 4
        }
    }

    guard let outCG = ctx.makeImage() else {
        FileHandle.standardError.write(Data("Error: Could not create output CGImage\n".utf8))
        exit(1)
    }

    do {
        try writePNG(cgImage: outCG, to: outputPath)
        print("Success! Saved to \(outputPath) (bg-color mode, target=#\(String(format: "%02x%02x%02x", target.r, target.g, target.b)), fuzz=\(fuzzPercent))")
    } catch {
        FileHandle.standardError.write(Data("Error writing PNG: \(error)\n".utf8))
        exit(1)
    }

} else {
    // ---- Vision API mode (preserved verbatim) ----------------------------

    guard let ciImage = CIImage(contentsOf: inputURL) else {
        print("Error: Could not load image from \(inputPath)")
        exit(1)
    }

    let handler = VNImageRequestHandler(ciImage: ciImage)
    let request = VNGenerateForegroundInstanceMaskRequest()

    do {
        try handler.perform([request])
    } catch {
        print("Error performing request: \(error)")
        exit(1)
    }

    guard let result = request.results?.first else {
        print("Error: No results from Vision request")
        exit(1)
    }

    do {
        let mask = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
        let maskCI = CIImage(cvPixelBuffer: mask)

        let context = CIContext()

        // Use CIFilter with name instead of convenience method
        guard let blendFilter = CIFilter(name: "CIBlendWithMask") else {
            print("Error: Could not create blend filter")
            exit(1)
        }

        blendFilter.setValue(ciImage, forKey: kCIInputImageKey)
        blendFilter.setValue(maskCI, forKey: kCIInputMaskImageKey)
        blendFilter.setValue(CIImage.empty(), forKey: kCIInputBackgroundImageKey)

        if let output = blendFilter.outputImage,
           let cgImage = context.createCGImage(output, from: output.extent) {
            let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
            if let tiff = nsImage.tiffRepresentation,
               let bitmap = NSBitmapImageRep(data: tiff),
               let png = bitmap.representation(using: NSBitmapImageRep.FileType.png, properties: [:]) {
                try png.write(to: URL(fileURLWithPath: outputPath))
                print("Success! Saved to \(outputPath)")
            }
        }
    } catch {
        print("Error generating mask: \(error)")
        exit(1)
    }
}
