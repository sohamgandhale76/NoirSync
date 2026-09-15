const fs = require('fs');

let content = fs.readFileSync('client/src/components/HostView.tsx', 'utf8');

// Replace .currentTime with .getCurrentTime() for reads
content = content.replace(/audio\.currentTime/g, "audio.getCurrentTime()");

// Fix the assignment which was accidentally broken by the above regex
content = content.replace(/audio\.getCurrentTime\(\) = 0;/g, "audio.seekTo(0);");
content = content.replace(/audio\.getCurrentTime\(\) = t;/g, "audio.seekTo(t);");
content = content.replace(/audio\.getCurrentTime\(\) = time;/g, "audio.seekTo(time);");

// Replace audio.duration with audio.getDuration()
content = content.replace(/audio\.duration/g, "audio.getDuration()");

// Replace addEventListener / removeEventListener
content = content.replace(/audio\.addEventListener\('timeupdate', handleTimeUpdate\);/g, "const unsubTimeUpdate = audio.on('timeupdate', handleTimeUpdate);");
content = content.replace(/audio\.addEventListener\('ended', handleEnded\);/g, "const unsubEnded = audio.on('ended', handleEnded);");
content = content.replace(/audio\.addEventListener\('loadedmetadata', handleDuration\);/g, "const unsubMetadata = audio.on('loadedmetadata', handleDuration);");

content = content.replace(/audio\.removeEventListener\('timeupdate', handleTimeUpdate\);/g, "unsubTimeUpdate();");
content = content.replace(/audio\.removeEventListener\('ended', handleEnded\);/g, "unsubEnded();");
content = content.replace(/audio\.removeEventListener\('loadedmetadata', handleDuration\);/g, "unsubMetadata();");

fs.writeFileSync('client/src/components/HostView.tsx', content);
