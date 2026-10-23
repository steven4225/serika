#include <sys/types.h>
#include <sys/sysctl.h>
#include <libproc.h>
#include <mach/mach.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <signal.h>
#include <servers/bootstrap.h>
extern int task_read_for_pid(mach_port_name_t, int, mach_port_name_t *);
extern int task_inspect_for_pid(mach_port_name_t, int, mach_port_name_t *);

static void wipe(void *data, size_t size) { volatile unsigned char *p = data; while (size--) *p++ = 0; }

int main(int argc, char **argv) {
  if ((argc != 5 && argc != 6) || strcmp(argv[1], "--pid") || strcmp(argv[3], "--home")) return 2;
  int read_control = argc == 6 && !strcmp(argv[5], "--read-control");
  int pid = atoi(argv[2]);
  int mib[] = { CTL_KERN, KERN_PROCARGS2, pid }, found = 0;
  size_t size = 0;
  errno = 0;
  int result = sysctl(mib, 3, NULL, &size, NULL, 0), saved = errno;
  if (result == 0 && size > 0 && size < 8 * 1024 * 1024) {
    char *buffer = calloc(1, size);
    if (!buffer) return 3;
    result = sysctl(mib, 3, buffer, &size, NULL, 0); saved = errno;
    const char *name = "PROBE_CREDENTIAL_CANARY=";
    if (result == 0) for (size_t i = 0; i + strlen(name) <= size; i++) if (!memcmp(buffer + i, name, strlen(name))) found = 1;
    wipe(buffer, size); free(buffer);
  }
  printf("{\"numericProcargs2\":{\"name\":\"PROBE_CREDENTIAL_CANARY\",\"variableNameObserved\":%s,\"blocked\":%s,\"errno\":%d}", found ? "true" : "false", result == -1 && (saved == EPERM || saved == EACCES) ? "true" : "false", result == -1 ? saved : 0);
  struct proc_bsdinfo info = {0};
  errno = 0;
  int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)); saved = errno;
  printf(",\"processInfo\":{\"blocked\":%s,\"errno\":%d}", bytes > 0 ? "false" : "true", saved);
  wipe(&info, sizeof(info));
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  errno = 0;
  bytes = proc_pidpath(pid, path, sizeof(path)); saved = errno;
  printf(",\"processPath\":{\"blocked\":%s,\"errno\":%d}", bytes > 0 ? "false" : "true", saved);
  wipe(path, sizeof(path));
  mach_port_t port = MACH_PORT_NULL;
  kern_return_t kr = task_for_pid(mach_task_self(), pid, &port);
  printf(",\"taskPort\":{\"blocked\":%s,\"result\":%d}", kr == KERN_SUCCESS ? "false" : "true", kr);
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  port = MACH_PORT_NULL;
  kr = task_read_for_pid(mach_task_self(), pid, &port);
  printf(",\"taskReadPort\":{\"blocked\":%s,\"result\":%d}", kr == 0 ? "false" : "true", kr);
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  port = MACH_PORT_NULL;
  kr = task_inspect_for_pid(mach_task_self(), pid, &port);
  printf(",\"taskInspectPort\":{\"blocked\":%s,\"result\":%d}", kr == 0 ? "false" : "true", kr);
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  port = MACH_PORT_NULL;
  kr = task_name_for_pid(mach_task_self(), pid, &port);
  printf(",\"taskNamePort\":{\"blocked\":%s,\"result\":%d}", kr == 0 ? "false" : "true", kr);
  if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  int procMib[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid }; struct kinfo_proc kp = {0}; size = sizeof(kp); errno = 0;
  result = sysctl(procMib, 4, &kp, &size, NULL, 0); saved = errno; wipe(&kp, sizeof(kp));
  printf(",\"numericProcInfo\":{\"blocked\":%s,\"errno\":%d}", result == -1 ? "true" : "false", saved);
  mib[1] = KERN_PROCARGS; size = 0; errno = 0;
  result = sysctl(mib, 3, NULL, &size, NULL, 0); saved = errno;
  printf(",\"numericProcargs\":{\"blocked\":%s,\"errno\":%d}", result == -1 ? "true" : "false", saved);
  int value = 0; size = sizeof(value); errno = 0;
  result = sysctlbyname("hw.ncpu", &value, &size, NULL, 0); saved = errno;
  printf(",\"runtimeSysctl\":{\"blocked\":%s,\"errno\":%d}", result == 0 ? "false" : "true", saved);
  errno = 0; result = read_control ? 0 : kill(pid, SIGUSR2); saved = errno;
  printf(",\"externalSignal\":{\"blocked\":%s,\"errno\":%d}", result == -1 ? "true" : "false", saved);
  const char *services[] = { "com.apple.cfprefsd.agent", "com.apple.coreservices.appleevents" };
  printf(",\"machServices\":[");
  for (int i = 0; i < 2; i++) {
    port = MACH_PORT_NULL; kr = bootstrap_look_up(bootstrap_port, services[i], &port);
    printf("%s{\"name\":\"%s\",\"blocked\":%s,\"result\":%d}", i ? "," : "", services[i], kr ? "true" : "false", kr);
    if (port != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), port);
  }
  printf("]");
  struct rlimit limit; if (getrlimit(RLIMIT_NOFILE, &limit)) return 4;
  int extra = 0, sockets = 0; struct stat st;
  for (rlim_t fd = 3; fd < limit.rlim_cur; fd++) if (fstat((int)fd, &st) == 0) { extra++; if (S_ISSOCK(st.st_mode)) sockets++; }
  printf(",\"descriptors\":{\"extraOpen\":%d,\"sockets\":%d}}\n", extra, sockets);
  return 0;
}
