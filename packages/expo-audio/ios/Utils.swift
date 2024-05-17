import AVFoundation

func createAVPlayer(source: AudioSource?) -> AVPlayer {
  return {
    if let source, let url = source.uri {
      do {
        let asset = AVURLAsset(url: url, options: source.headers)
        let item = AVPlayerItem(asset: asset)
        return try AVPlayer(playerItem: item)
      } catch {
        return AVPlayer()
      }
    }
    return AVPlayer()
  }()
}

func getFormatIDFromString(typeString: String) -> UInt32? {
  let s = (typeString as NSString).utf8String
  if let s {
    return UInt32(s[3]) | (UInt32(s[2]) << 8) | (UInt32(s[1]) << 16) | (UInt32(s[0]) << 24)
  }
  return nil
}
