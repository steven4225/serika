#include <unistd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>
#include <spawn.h>
extern char **environ;
static volatile sig_atomic_t terminated = 0;
static void on_term(int signal_number) { (void)signal_number; terminated = 1; }
int main(int argc, char **argv) {
 if(argc!=5 || strcmp(argv[1],"--temp") || strcmp(argv[3],"--home")) return 2;
 pid_t first=fork(); if(first<0) return 3;
 if(first>0) return 0;
 pid_t second=fork(); if(second<0) _exit(4); if(second>0) _exit(0);
 errno=0; int session=setsid(),session_error=errno;
 errno=0; int group=setpgid(0,0),group_error=errno;
 signal(SIGTERM,on_term);
 char path[4096]; snprintf(path,sizeof(path),"%s/ready.json",argv[2]); FILE *ready=fopen(path,"w");
 if(!ready) return 5;
 fprintf(ready,"{\"pid\":%d,\"pgid\":%d,\"setsidBlocked\":%s,\"setsidErrno\":%d,\"setpgidBlocked\":%s,\"setpgidErrno\":%d}",getpid(),getpgrp(),session==-1?"true":"false",session_error,group==-1?"true":"false",group_error);fclose(ready);
 snprintf(path,sizeof(path),"%s/heartbeat",argv[2]);
 for(int i=0,spawned=0;;i++){
  if(terminated && !spawned){
   spawned=1; pid_t late=fork();
   if(late==0){signal(SIGTERM,SIG_IGN);char latepath[4096];snprintf(latepath,sizeof(latepath),"%s/after-term.pid",argv[2]);FILE *f=fopen(latepath,"w");if(f){fprintf(f,"%d",getpid());fclose(f);}}
  }
  FILE *f=fopen(path,"w");if(f){fprintf(f,"%d",i);fclose(f);}usleep(20000);
 }
}
