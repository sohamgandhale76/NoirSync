const fs = require('fs');

function processFile(path) {
  let content = fs.readFileSync(path, 'utf8');

  // Replace Props
  content = content.replace(/audioRef: React\.RefObject<HTMLAudioElement \| null>;/g, "adapter: any;");
  
  // Replace destructured props
  content = content.replace(/, audioRef }: Props\)/g, ", adapter }: Props)");
  content = content.replace(/audioRef,/g, "adapter,");
  
  // HostView specific
  content = content.replace(/audioRef\.current\.src = url;/g, "adapter.setSrc(url);");
  content = content.replace(/audioRef\.current\.src = objectUrl;/g, "adapter.setSrc(objectUrl);");
  content = content.replace(/audioRef\.current\.src = '';/g, "adapter.setSrc('');");
  content = content.replace(/audioRef\.current\.load\(\);/g, ""); // adapter sets src and loads automatically
  
  // ViewerView specific
  content = content.replace(/audioRef\.current && !audioRef\.current\.src\.startsWith\('blob:'\)/g, "adapter && !adapter.getSrc().startsWith('blob:')");
  content = content.replace(/audioRef\.current\.src = URL\.createObjectURL\(blob\);/g, "adapter.setSrc(URL.createObjectURL(blob));");
  
  // General
  content = content.replace(/const audio = audioRef\.current;/g, "const audio = adapter;");
  content = content.replace(/!audioRef\.current/g, "!adapter");
  content = content.replace(/if \(audioRef\.current\) \{/g, "if (adapter) {");
  content = content.replace(/if \(audioRef\.current\) audioRef\.current\.currentTime = 0;/g, "if (adapter) adapter.seekTo(0);");
  content = content.replace(/audioRef\.current\.currentTime = t;/g, "adapter.seekTo(t);");
  
  // Replace play/pause
  content = content.replace(/audioRef\.current\.play\(\)/g, "adapter.play()");
  
  // Volume
  content = content.replace(/audioRef\.current\.volume = val;/g, "adapter.setVolume(val);");
  content = content.replace(/audioRef\.current\.volume = volume;/g, "adapter.setVolume(volume);");
  
  fs.writeFileSync(path, content);
}

processFile('client/src/components/HostView.tsx');
processFile('client/src/components/ViewerView.tsx');
