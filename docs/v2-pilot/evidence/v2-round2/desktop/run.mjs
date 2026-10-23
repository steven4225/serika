import {spawn} from 'node:child_process';
const args=process.argv.slice(2), i=args.indexOf('--home'); if(i<0||!args[i+1]?.startsWith('/private/tmp/')) throw Error('explicit temp --home required');
const home=args[i+1];args.splice(i,2); const child=spawn(args.shift(),args,{stdio:'inherit',env:{...process.env,HOME:home,SERIKA_HOME:home,RUNLOOM_HOME:home}});child.on('exit',code=>process.exit(code??1));
