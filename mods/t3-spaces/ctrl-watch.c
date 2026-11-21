#include <CoreGraphics/CoreGraphics.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static int is_ctrl_held(void) {
  CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
  return (flags & kCGEventFlagMaskControl) != 0 ? 1 : 0;
}

int main(int argc, char **argv) {
  int expected = (argc > 1 && argv[1][0] == '1') ? 1 : 0;
  int max_seconds = (argc > 2) ? atoi(argv[2]) : 15;
  if (max_seconds <= 0) max_seconds = 15;
  const useconds_t interval_us = 25000;
  int max_ticks = (max_seconds * 1000000) / (int)interval_us;

  for (int i = 0; i < max_ticks; i++) {
    int now = is_ctrl_held();
    if (now != expected) {
      printf("%d\n", now);
      return 0;
    }
    usleep(interval_us);
  }
  return 2;
}
