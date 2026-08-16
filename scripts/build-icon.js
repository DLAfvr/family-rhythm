'use strict';
const fs=require('node:fs');
const path=require('node:path');
const sharp=require('sharp');
const source=path.join(__dirname,'..','src','assets','icon.svg');
const output=path.join(__dirname,'..','src','assets','icon.png');
sharp(source).resize(512,512).png().toFile(output).then(()=>console.log(`Created ${output}`));
