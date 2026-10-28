# Native video player for 影库: AetherEngine (FFmpeg demux, VideoToolbox HEVC/H.264/AV1 decode,
# Dolby Vision / HDR10 / Atmos through AVPlayer) behind an Expo view. The package also gets added
# to the app target by plugins/with-aether-engine.js so its dynamic FFmpeg frameworks are embedded.
Pod::Spec.new do |s|
  s.name           = 'MediahubPlayer'
  s.version        = '1.0.0'
  s.summary        = 'AetherEngine video player view for 影库'
  s.author         = 'mediahub contributors'
  s.homepage       = 'https://github.com/genguzzz/mediahub-oss'
  s.license        = 'MIT'
  s.platforms      = { :ios => '18.0' }
  s.source         = { git: 'https://github.com/genguzzz/mediahub-oss.git' }
  s.static_framework = true
  s.swift_version  = '5.9'

  s.dependency 'ExpoModulesCore'
  spm_dependency(s,
    url: 'https://github.com/superuser404notfound/AetherEngine.git',
    requirement: { kind: 'exactVersion', version: '7.48.0' },
    products: ['AetherEngine']
  )

  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,swift}'
end
