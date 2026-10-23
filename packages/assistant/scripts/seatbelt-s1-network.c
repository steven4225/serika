#include <sys/socket.h>
#include <arpa/inet.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 4 || strcmp(argv[2], "--home")) return 2;
  printf("{");
  for (int family = 0; family < 2; family++) for (int kind = 0; kind < 3; kind++) {
    int fd = socket(family ? AF_INET6 : AF_INET, kind == 1 ? SOCK_DGRAM : SOCK_STREAM, 0);
    struct sockaddr_in a = {0}; a.sin_family = AF_INET; a.sin_port = htons(atoi(argv[1])); inet_pton(AF_INET,"127.0.0.1",&a.sin_addr);
    struct sockaddr_in6 b = {0}; b.sin6_family = AF_INET6; b.sin6_port = a.sin_port; inet_pton(AF_INET6,"::1",&b.sin6_addr);
    void *address = family ? (void *)&b : (void *)&a;
    socklen_t size = family ? sizeof(b) : sizeof(a);
    errno = 0;
    int r = fd < 0 ? -1 : kind == 0 ? connect(fd,address,size) : kind == 1 ? (int)sendto(fd,"DNS-test-only",13,0,address,size) : bind(fd,address,size);
    int saved = errno;
    printf("%s\"%s%d\":{\"blocked\":%s,\"errno\":%d}", family || kind ? "," : "",kind == 0 ? "TCP" : kind == 1 ? "UDP-DNS" : "bind-listen",family ? 6 : 4,r < 0 && (saved == EPERM || saved == EACCES) ? "true" : "false",saved);
    if(fd >= 0) close(fd);
  }
  printf("}\n");return 0;
}
