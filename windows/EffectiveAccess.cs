using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Greenflix.Operations {
  public static class EffectiveAccess {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
    // OPEN_EXISTING only. Requesting access on a directory/file never creates or changes it.
    public static string Check(string path,uint access) {
      using(var handle=CreateFile(path,access,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
        if(!handle.IsInvalid) return "ALLOWED";
        int error=Marshal.GetLastWin32Error();
        return error==5 ? "DENIED" : "UNAVAILABLE";
      }
    }
  }
}
