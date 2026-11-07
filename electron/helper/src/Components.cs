using System;
using System.Collections.Generic;
using System.Linq;
using System.Management;
using System.Text;
using Microsoft.Win32;

namespace GUltra
{
    // Everything inside the PC, with the details needed to find a replacement part.
    static class Components
    {
        class Group
        {
            public string Id, Title;
            public List<object> Items = new List<object>();
        }

        // replace: yes = user-replaceable, tech = by a technician, no = soldered, check = depends on the model
        static object Item(string name, string replace, string note, string search, params string[] specs)
        {
            var rows = new List<object>();
            for (int i = 0; i + 1 < specs.Length; i += 2)
            {
                string value = Clean(specs[i + 1]);
                if (value.Length > 0) rows.Add(new List<object> { specs[i], value });
            }
            return J.D("name", name, "replace", replace, "note", note, "search", search, "specs", rows);
        }

        static string Clean(string s)
        {
            s = (s ?? "").Trim();
            string[] junk = { "To Be Filled By O.E.M.", "Default string", "Not Specified", "None", "Unknown", "System Serial Number", "Not Applicable", "N/A", "0" };
            return junk.Any(j => s.Equals(j, StringComparison.OrdinalIgnoreCase)) ? "" : s;
        }

        static string S(ManagementBaseObject o, string prop)
        {
            try { return SystemInfo.Str(o[prop]); }
            catch { return ""; }
        }

        static long L(ManagementBaseObject o, string prop)
        {
            try { return o[prop] == null ? 0 : Convert.ToInt64(o[prop]); }
            catch { return 0; }
        }

        static string Gb(long bytes)
        {
            double gb = bytes / (double)(1L << 30);
            return gb >= 1024 ? (gb / 1024).ToString("0.#") + " TB" : gb >= 10 ? gb.ToString("0") + " GB" : gb.ToString("0.#") + " GB";
        }

        static string WmiDate(string cim)
        {
            return cim != null && cim.Length >= 8 ? cim.Substring(0, 4) + "-" + cim.Substring(4, 2) + "-" + cim.Substring(6, 2) : "";
        }

        public static object Get()
        {
            string maker = "", model = "", sku = "", family = "";
            bool laptop = false;
            SystemInfo.Wmi("Win32_ComputerSystem", o =>
            {
                maker = S(o, "Manufacturer");
                model = S(o, "Model");
                sku = S(o, "SystemSKUNumber");
                family = S(o, "SystemFamily");
                laptop = L(o, "PCSystemType") == 2;
            });
            string device = model.StartsWith(maker, StringComparison.OrdinalIgnoreCase) ? model : maker + " " + model;

            var groups = new List<Group>();
            Func<string, string, Group> add = (id, title) =>
            {
                var g = new Group { Id = id, Title = title };
                groups.Add(g);
                return g;
            };

            // ---- the device itself ----
            var system = add("system", laptop ? "Laptop" : "Computer");
            string serial = "", biosVersion = "", biosDate = "", biosMaker = "", chassisSerial = "";
            SystemInfo.Wmi("Win32_BIOS", o =>
            {
                serial = S(o, "SerialNumber");
                biosVersion = S(o, "SMBIOSBIOSVersion");
                biosDate = WmiDate(S(o, "ReleaseDate"));
                biosMaker = S(o, "Manufacturer");
            });
            SystemInfo.Wmi("Win32_SystemEnclosure", o => { chassisSerial = S(o, "SerialNumber"); });
            system.Items.Add(Item(device, null, "Quote this model and serial number when ordering original parts.", device + " parts",
                "Manufacturer", maker, "Model", model, "Product number", sku, "Family", family, "Serial number", serial.Length > 0 ? serial : chassisSerial));

            // ---- motherboard ----
            var board = add("board", "Motherboard");
            SystemInfo.Wmi("Win32_BaseBoard", o =>
            {
                string product = S(o, "Product");
                string title = (S(o, "Manufacturer") + " " + product).Trim();
                board.Items.Add(Item(title, laptop ? "tech" : "yes", laptop ? "Laptop boards are specific to the model. The processor usually comes soldered to it." : "A new board has to match the processor socket and the RAM type.", (laptop ? device + " motherboard " : "") + product,
                    "Manufacturer", S(o, "Manufacturer"), "Board", product, "Version", S(o, "Version"), "Serial number", S(o, "SerialNumber"),
                    "BIOS", (biosMaker + " " + biosVersion).Trim(), "BIOS date", biosDate));
            });

            // ---- processor ----
            var cpu = add("cpu", "Processor");
            SystemInfo.Wmi("Win32_Processor", o =>
            {
                string name = S(o, "Name").Replace("(R)", "").Replace("(TM)", "").Trim();
                string socket = S(o, "SocketDesignation");
                bool soldered = laptop || socket.IndexOf("BGA", StringComparison.OrdinalIgnoreCase) >= 0;
                cpu.Items.Add(Item(name, soldered ? "no" : "yes", soldered ? "Soldered to the motherboard." : "A replacement has to fit socket " + socket + " and be supported by this board.", name,
                    "Socket", socket, "Cores", L(o, "NumberOfCores").ToString(), "Threads", L(o, "NumberOfLogicalProcessors").ToString(),
                    "Base clock", L(o, "MaxClockSpeed") > 0 ? (L(o, "MaxClockSpeed") / 1000.0).ToString("0.00") + " GHz" : "",
                    "L2 cache", L(o, "L2CacheSize") > 0 ? (L(o, "L2CacheSize") / 1024.0).ToString("0.#") + " MB" : "",
                    "L3 cache", L(o, "L3CacheSize") > 0 ? (L(o, "L3CacheSize") / 1024.0).ToString("0.#") + " MB" : "",
                    "Revision", S(o, "Caption")));
            });

            // ---- graphics ----
            var gpu = add("gpu", "Graphics");
            SystemInfo.Wmi("Win32_VideoController", o =>
            {
                string name = S(o, "Name");
                if (name.Length == 0 || name.IndexOf("Basic Display", StringComparison.OrdinalIgnoreCase) >= 0) return;
                bool integrated = name.IndexOf("Intel", StringComparison.OrdinalIgnoreCase) >= 0 && name.IndexOf("Arc", StringComparison.OrdinalIgnoreCase) < 0
                    || name.EndsWith("Radeon(TM) Graphics", StringComparison.OrdinalIgnoreCase) || name.EndsWith("Radeon Graphics", StringComparison.OrdinalIgnoreCase);
                string replace = integrated || laptop ? "no" : "yes";
                string note = integrated ? "Built into the processor." : laptop ? "Soldered to the motherboard." : "Check your power supply and case size before buying.";
                gpu.Items.Add(Item(name, replace, note, name,
                    "Maker", S(o, "AdapterCompatibility"), "Chip", S(o, "VideoProcessor"), "Driver", S(o, "DriverVersion"), "Driver date", WmiDate(S(o, "DriverDate")),
                    "Resolution now", L(o, "CurrentHorizontalResolution") > 0 ? L(o, "CurrentHorizontalResolution") + " x " + L(o, "CurrentVerticalResolution") + " at " + L(o, "CurrentRefreshRate") + " Hz" : ""));
            });

            // ---- memory ----
            var ram = add("ram", "Memory");
            var mem = MemoryInfo.Get() as Dictionary<string, object>;
            var modules = (mem["modules"] as List<object>) ?? new List<object>();
            foreach (Dictionary<string, object> m in modules)
            {
                string part = m["partNumber"] as string ?? "";
                string title = (m["manufacturer"] + " " + Gb(Convert.ToInt64(m["capacity"])) + " " + (m["type"] ?? "") + " " + (m["form"] ?? "")).Trim();
                bool soldered = m["soldered"] is bool && (bool)m["soldered"];
                ram.Items.Add(Item(title, soldered ? "no" : "yes", soldered ? "Soldered to the motherboard." : null, part.Length > 0 ? part : title,
                    "Part number", part, "Speed", Convert.ToInt32(m["speed"]) > 0 ? m["speed"] + " MT/s" : "",
                    "Voltage", m["voltage"] != null ? Convert.ToDouble(m["voltage"]).ToString("0.##") + " V" : "", "Slot", m["slot"] as string));
            }
            int free = Convert.ToInt32(mem["slotsTotal"]) - Convert.ToInt32(mem["slotsUsed"]);
            for (int i = 0; i < free; i++) ram.Items.Add(Item("Free slot", "yes", "Nothing installed here.", null));

            // ---- storage ----
            var storage = add("storage", "Storage");
            var firmware = new Dictionary<int, KeyValuePair<string, string>>();
            SystemInfo.Wmi("Win32_DiskDrive", o =>
            {
                firmware[(int)L(o, "Index")] = new KeyValuePair<string, string>(S(o, "FirmwareRevision"), S(o, "SerialNumber"));
            });
            foreach (var d in DiskInfo.Physical(60))
            {
                KeyValuePair<string, string> info;
                firmware.TryGetValue(d.Index, out info);
                string kind = d.Media ?? (d.Model.IndexOf("Card", StringComparison.OrdinalIgnoreCase) >= 0 ? "Memory card" : "Drive");
                string format = d.Bus == "NVMe" ? "M.2 NVMe" : d.Bus == "SATA" ? (d.Media == "HDD" ? "SATA" : "SATA (2.5 inch or M.2)") : d.Bus;
                string note = d.Bus == "NVMe" ? "Check the length your slot takes, usually 2280, before buying." : null;
                storage.Items.Add(Item(d.Model, "yes", note, d.Model,
                    "Type", kind, "Connection", format, "Capacity", Gb(d.Size), "Firmware", info.Key, "Serial number", info.Value,
                    "Drive letters", string.Join(" ", d.Letters)));
            }

            // ---- displays ----
            var display = add("display", "Displays");
            AddDisplays(display, laptop, device);

            // ---- battery ----
            var battery = BatteryInfo.Health() as Dictionary<string, object>;
            if (battery != null)
            {
                var report = BatteryService.Report() as Dictionary<string, object>;
                Func<string, string> rep = k => report != null && report.ContainsKey(k) && report[k] != null ? report[k].ToString() : "";
                var g = add("battery", "Battery");
                string name = (battery["name"] as string ?? "").Trim();
                string id = rep("id");
                string partCode = name.Length > 0 ? name : id;
                g.Items.Add(Item(((battery["manufacturer"] as string ?? "") + " " + partCode).Trim(), "tech", "Quote the laptop model too: batteries are specific to it.", device + " battery " + partCode,
                    "Battery code", partCode, "Chemistry", battery["chemistry"] as string,
                    "Factory capacity", Convert.ToInt64(battery["designCapacity"]) > 0 ? (Convert.ToInt64(battery["designCapacity"]) / 1000.0).ToString("0.#") + " Wh" : "",
                    "Capacity now", Convert.ToInt64(battery["fullCapacity"]) > 0 ? (Convert.ToInt64(battery["fullCapacity"]) / 1000.0).ToString("0.#") + " Wh" : "",
                    "Cycles", battery["cycles"] != null ? battery["cycles"].ToString() : rep("cycles"),
                    "Serial number", rep("serial"), "Made on", rep("manufactureDate")));
                g.Items.Add(Item("Charger", "yes", "Windows can't read the charger model. The label on it lists the wattage and connector.", device + " charger"));
            }
            else
            {
                add("battery", "Power").Items.Add(Item("Power supply", "yes", "Windows can't read the power supply model. It's printed on its label.", null));
            }

            // ---- cooling ----
            var cooling = add("cooling", "Cooling");
            foreach (Dictionary<string, object> f in Fans.Snapshot())
                cooling.Items.Add(Item(f["name"] + " · " + f["hardware"], laptop ? "tech" : "yes", null, laptop ? device + " cooling fan" : null,
                    "Speed now", f["rpm"] != null ? f["rpm"] + " RPM" : ""));
            if (cooling.Items.Count == 0)
                cooling.Items.Add(Item(laptop ? "Cooling fan" : "Fans", laptop ? "tech" : "yes", "The firmware doesn't report fans to Windows. Search by the model to find the part.", laptop ? device + " cooling fan" : null));

            // ---- everything else comes from the device list ----
            var devices = new List<KeyValuePair<string, KeyValuePair<string, string>>>();
            SystemInfo.WmiNs(@"root\cimv2", "SELECT Name,PNPClass,Manufacturer FROM Win32_PnPEntity WHERE Present = TRUE", o =>
            {
                devices.Add(new KeyValuePair<string, KeyValuePair<string, string>>(S(o, "PNPClass"), new KeyValuePair<string, string>(S(o, "Name"), S(o, "Manufacturer"))));
            });
            Func<Func<string, string, bool>, List<KeyValuePair<string, string>>> pick = match =>
                devices.Where(d => match(d.Key, d.Value.Key)).Select(d => d.Value)
                    .GroupBy(d => d.Key, StringComparer.OrdinalIgnoreCase).Select(x => x.First()).ToList();

            // ---- network ----
            var net = add("network", "Network");
            SystemInfo.WmiNs(@"root\cimv2", "SELECT Name,Manufacturer,AdapterType,PNPDeviceID FROM Win32_NetworkAdapter WHERE PhysicalAdapter = TRUE", o =>
            {
                string pnpId = S(o, "PNPDeviceID");
                if (!pnpId.StartsWith("PCI", StringComparison.OrdinalIgnoreCase) && !pnpId.StartsWith("USB", StringComparison.OrdinalIgnoreCase)) return;
                string name = S(o, "Name");
                bool wifi = name.IndexOf("Wi-Fi", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Wireless", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("802.11", StringComparison.OrdinalIgnoreCase) >= 0;
                net.Items.Add(Item(name, wifi ? "check" : (laptop ? "no" : "yes"), wifi ? "Usually a small M.2 card you can swap, but some laptops solder it." : null, name, "Maker", S(o, "Manufacturer"), "Type", wifi ? "Wi-Fi" : S(o, "AdapterType")));
            });
            foreach (var b in pick((cls, name) => cls.Equals("Bluetooth", StringComparison.OrdinalIgnoreCase) && name.IndexOf("Bluetooth", StringComparison.OrdinalIgnoreCase) >= 0 && (name.IndexOf("Adapter", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Wireless", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Intel", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Realtek", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Qualcomm", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("MediaTek", StringComparison.OrdinalIgnoreCase) >= 0)))
                net.Items.Add(Item(b.Key, "check", "Usually on the same card as Wi-Fi.", b.Key, "Maker", b.Value, "Type", "Bluetooth"));

            // ---- audio ----
            var audio = add("audio", "Audio");
            SystemInfo.Wmi("Win32_SoundDevice", o => audio.Items.Add(Item(S(o, "Name"), "no", null, null, "Maker", S(o, "Manufacturer"))));
            if (laptop) audio.Items.Add(Item("Built-in speakers", "tech", "Sold per laptop model.", device + " speakers"));

            // ---- camera and biometrics ----
            var camera = add("camera", "Camera and sign-in");
            foreach (var c in pick((cls, name) => cls.Equals("Camera", StringComparison.OrdinalIgnoreCase) || cls.Equals("Image", StringComparison.OrdinalIgnoreCase)))
                camera.Items.Add(Item(c.Key, laptop ? "tech" : "yes", null, laptop ? device + " webcam" : c.Key, "Maker", c.Value));
            foreach (var c in pick((cls, name) => cls.Equals("Biometric", StringComparison.OrdinalIgnoreCase)))
                camera.Items.Add(Item(c.Key, laptop ? "tech" : "yes", null, laptop ? device + " fingerprint reader" : c.Key, "Maker", c.Value));

            // ---- input ----
            var input = add("input", "Keyboard and input");
            if (laptop)
            {
                input.Items.Add(Item("Built-in keyboard", "tech", "Sold per laptop model and keyboard layout.", device + " keyboard replacement"));
                input.Items.Add(Item("Touchpad", "tech", null, device + " touchpad"));
            }
            SystemInfo.Wmi("Win32_PointingDevice", o =>
            {
                string name = S(o, "Name");
                if (name.IndexOf("HID-compliant mouse", StringComparison.OrdinalIgnoreCase) >= 0) return;
                input.Items.Add(Item(name, null, null, null, "Maker", S(o, "Manufacturer")));
            });
            foreach (var t in pick((cls, name) => name.IndexOf("touch screen", StringComparison.OrdinalIgnoreCase) >= 0))
                input.Items.Add(Item(t.Key, "tech", "Usually part of the screen assembly.", null, "Maker", t.Value));

            // ---- ports and controllers ----
            var ports = add("ports", "Ports and controllers");
            SystemInfo.Wmi("Win32_USBController", o => ports.Items.Add(Item(S(o, "Name"), "no", null, null, "Maker", S(o, "Manufacturer"))));
            foreach (var c in pick((cls, name) => cls.Equals("SDHost", StringComparison.OrdinalIgnoreCase) || name.IndexOf("Card Reader", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("Thunderbolt", StringComparison.OrdinalIgnoreCase) >= 0))
                ports.Items.Add(Item(c.Key, "no", null, null, "Maker", c.Value));
            SystemInfo.Wmi("Win32_SCSIController", o => ports.Items.Add(Item(S(o, "Name"), "no", null, null, "Maker", S(o, "Manufacturer"))));
            foreach (var c in pick((cls, name) => cls.Equals("SecurityDevices", StringComparison.OrdinalIgnoreCase)))
                ports.Items.Add(Item(c.Key, "no", "Security chip on the motherboard.", null, "Maker", c.Value));
            foreach (var c in pick((cls, name) => cls.Equals("System", StringComparison.OrdinalIgnoreCase) && (name.IndexOf("LPC", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("eSPI", StringComparison.OrdinalIgnoreCase) >= 0)))
                ports.Items.Add(Item(c.Key, "no", "The motherboard chipset.", null, "Maker", c.Value));

            // ---- expansion slots ----
            var slots = new Group { Id = "slots", Title = "Expansion slots" };
            SystemInfo.Wmi("Win32_SystemSlot", o =>
            {
                string name = S(o, "SlotDesignation");
                if (name.Length == 0) return;
                long usage = L(o, "CurrentUsage");
                slots.Items.Add(Item(name, null, null, null, "Status", usage == 3 ? "Free" : usage == 4 ? "In use" : ""));
            });
            if (slots.Items.Count > 0) groups.Add(slots);

            return J.D("platform", "windows", "device", device, "groups", groups.Where(g => g.Items.Count > 0).Select(g => (object)J.D("id", g.Id, "title", g.Title, "items", g.Items)).ToList());
        }

        static readonly Dictionary<string, string> PanelMakers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { "AUO", "AU Optronics" }, { "BOE", "BOE" }, { "CMN", "Innolux" }, { "LGD", "LG Display" }, { "SHP", "Sharp" }, { "SDC", "Samsung Display" },
            { "IVO", "InfoVision" }, { "CSO", "CSOT" }, { "TMA", "Tianma" }, { "DEL", "Dell" }, { "ACR", "Acer" }, { "SAM", "Samsung" }, { "GSM", "LG" },
            { "HWP", "HP" }, { "HPN", "HP" }, { "AUS", "ASUS" }, { "AOC", "AOC" }, { "BNQ", "BenQ" }, { "MSI", "MSI" }, { "VSC", "ViewSonic" }, { "PHL", "Philips" }, { "LEN", "Lenovo" }, { "GBT", "Gigabyte" },
        };

        static string FromCodes(object codes)
        {
            var arr = codes as ushort[];
            if (arr == null) return "";
            var sb = new StringBuilder();
            foreach (ushort c in arr) if (c > 31 && c < 127) sb.Append((char)c);
            return sb.ToString().Trim();
        }

        static void AddDisplays(Group display, bool laptop, string device)
        {
            var sizes = new Dictionary<string, string>();
            SystemInfo.WmiNs(@"root\wmi", "SELECT InstanceName,MaxHorizontalImageSize,MaxVerticalImageSize FROM WmiMonitorBasicDisplayParams", o =>
            {
                double w = L(o, "MaxHorizontalImageSize"), h = L(o, "MaxVerticalImageSize");
                if (w > 0 && h > 0) sizes[S(o, "InstanceName")] = (Math.Sqrt(w * w + h * h) / 2.54).ToString("0.#") + " inch";
            });
            SystemInfo.WmiNs(@"root\wmi", "SELECT * FROM WmiMonitorID", o =>
            {
                string instance = S(o, "InstanceName");
                string code = FromCodes(o["ManufacturerName"]);
                string maker;
                if (!PanelMakers.TryGetValue(code, out maker)) maker = code;
                string product = FromCodes(o["ProductCodeID"]);
                string friendly = FromCodes(o["UserFriendlyName"]);
                string size;
                sizes.TryGetValue(instance, out size);
                bool builtIn = laptop && friendly.Length == 0 || laptop && display.Items.Count == 0;

                string panelCode, resolution;
                ReadEdid(instance, out panelCode, out resolution);
                string title = friendly.Length > 0 ? (friendly.StartsWith(maker, StringComparison.OrdinalIgnoreCase) ? friendly : maker + " " + friendly) : builtIn ? "Built-in screen" : (maker + " " + product).Trim();
                string search = builtIn
                    ? (panelCode.Length > 0 ? panelCode + " laptop screen" : device + " screen replacement")
                    : title;
                string note = builtIn ? "Match the panel code, size, resolution and connector. Touch screens are usually sold as an assembly." : null;
                display.Items.Add(Item(title, builtIn ? "tech" : "yes", note, search,
                    "Panel maker", maker, "Panel code", panelCode, "Product code", product, "Size", size, "Native resolution", resolution,
                    "Made in", L(o, "YearOfManufacture") > 0 ? L(o, "YearOfManufacture").ToString() : ""));
            });
            if (display.Items.Count == 0 && laptop)
                display.Items.Add(Item("Built-in screen", "tech", null, device + " screen replacement"));
        }

        // The display's own data block often names the exact panel, which is what replacement screens are sold by.
        static void ReadEdid(string instance, out string panelCode, out string resolution)
        {
            panelCode = "";
            resolution = "";
            try
            {
                string path = instance;
                int suffix = path.LastIndexOf('_');
                if (suffix > 0) path = path.Substring(0, suffix);
                using (var k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum\" + path + @"\Device Parameters"))
                {
                    byte[] e = k == null ? null : k.GetValue("EDID") as byte[];
                    if (e == null || e.Length < 128) return;
                    var texts = new List<string>();
                    for (int off = 54; off <= 108; off += 18)
                    {
                        if (e[off] != 0 || e[off + 1] != 0)
                        {
                            if (off == 54)
                            {
                                int clock = (e[off] | (e[off + 1] << 8)) * 10000;
                                int hA = e[off + 2] | ((e[off + 4] & 0xF0) << 4);
                                int hB = e[off + 3] | ((e[off + 4] & 0x0F) << 8);
                                int vA = e[off + 5] | ((e[off + 7] & 0xF0) << 4);
                                int vB = e[off + 6] | ((e[off + 7] & 0x0F) << 8);
                                if (hA > 0 && vA > 0)
                                    resolution = hA + " x " + vA + ((hA + hB) * (vA + vB) > 0 ? " at " + Math.Round(clock / (double)((hA + hB) * (vA + vB))) + " Hz" : "");
                            }
                            continue;
                        }
                        byte tag = e[off + 3];
                        if (tag != 0xFE && tag != 0xFC) continue;
                        string text = Encoding.ASCII.GetString(e, off + 5, 13).Split('\n')[0].Trim();
                        if (text.Length > 0) texts.Add(text);
                    }
                    // The longest text with both letters and digits is the panel's part number.
                    panelCode = texts.Where(t => t.Any(char.IsDigit) && t.Any(char.IsLetter)).OrderByDescending(t => t.Length).FirstOrDefault() ?? "";
                }
            }
            catch { }
        }
    }
}
